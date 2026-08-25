import { EventEmitter } from 'node:events';
import type { IncomingMessage, ClientRequest, RequestOptions } from 'node:http';
import { Readable } from 'node:stream';
import {
  createOutboundFetch,
  isPublicAddress,
  OutboundUrlError,
  type ResolvedAddress,
} from './outbound-fetch';

interface Route {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  remoteAddress?: string;
}

function fakeTransport(routes: Record<string, Route>) {
  const requests: Array<{ url: string; options: RequestOptions }> = [];
  const request = (url: URL, options: RequestOptions, callback: (response: IncomingMessage) => void) => {
    requests.push({ url: url.href, options });
    const req = new EventEmitter() as ClientRequest;
    req.end = (() => {
      const route = routes[url.href];
      if (!route) throw new Error(`unexpected request to ${url.href}`);
      const lookup = options.lookup;
      if (!lookup) throw new Error('request did not receive a pinned lookup');
      lookup(url.hostname, { all: false }, (error, address) => {
        if (error) {
          req.emit('error', error);
          return;
        }
        const response = Readable.from([Buffer.from(route.body ?? 'ok')]) as IncomingMessage;
        response.statusCode = route.status ?? 200;
        response.statusMessage = 'OK';
        response.headers = route.headers ?? {};
        Object.defineProperty(response, 'socket', {
          value: { remoteAddress: route.remoteAddress ?? address },
        });
        callback(response);
      });
      return req;
    }) as ClientRequest['end'];
    return req;
  };
  return { request, requests };
}

const publicV4: ResolvedAddress = { address: '93.184.216.34', family: 4 };
const publicV6: ResolvedAddress = { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 };

describe('isPublicAddress', () => {
  it.each([
    '0.0.0.0',
    '10.0.0.1',
    '100.100.100.200',
    '100.64.0.1',
    '127.255.255.255',
    '169.254.169.254',
    '172.31.255.255',
    '192.168.1.1',
    '192.88.99.1',
    '224.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    '::ffff:127.0.0.1',
    '64:ff9b::7f00:1',
    '2001::1',
    '2002:7f00:1::',
    '3fff::1',
    '5f00::1',
    'fc00::1',
    'fe80::1',
    'ff02::1',
  ])('rejects non-public address %s', (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each([publicV4.address, publicV6.address])('allows public address %s', (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });
});

describe('createOutboundFetch', () => {
  it.each([
    'http://127.0.0.1/',
    'http://127.1/',
    'http://2130706433/',
    'http://0x7f000001/',
    'http://0177.0.0.1/',
    'http://[::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://%31%32%37.0.0.1/',
  ])('blocks encoded or literal loopback URL %s', async (url) => {
    const transport = fakeTransport({});
    const fetch = createOutboundFetch({ request: transport.request });

    await expect(fetch(url)).rejects.toBeInstanceOf(OutboundUrlError);
    expect(transport.requests).toHaveLength(0);
  });

  it('blocks hostnames with a private DNS answer', async () => {
    const resolve = jest.fn(async () => [{ address: '10.0.0.8', family: 4 as const }]);
    const transport = fakeTransport({});
    const fetch = createOutboundFetch({ resolve, request: transport.request });

    await expect(fetch('https://internal.example/')).rejects.toThrow('non-public');
    expect(transport.requests).toHaveLength(0);
  });

  it('blocks hostnames when any DNS answer is private', async () => {
    const resolve = jest.fn(async () => [publicV4, { address: 'fd00::1', family: 6 as const }]);
    const transport = fakeTransport({});
    const fetch = createOutboundFetch({ resolve, request: transport.request });

    await expect(fetch('https://mixed.example/')).rejects.toThrow('non-public');
    expect(transport.requests).toHaveLength(0);
  });

  it('pins the connection to a validated DNS answer without resolving again', async () => {
    const resolve = jest.fn(async () => [publicV4]);
    const transport = fakeTransport({ 'https://public.example/': { body: 'safe' } });
    const fetch = createOutboundFetch({ resolve, request: transport.request });

    await expect((await fetch('https://public.example/')).text()).resolves.toBe('safe');
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(transport.requests).toHaveLength(1);

    const pinned = transport.requests[0]?.options.lookup;
    expect(pinned).toBeDefined();
    await new Promise<void>((resolveLookup, reject) => {
      pinned?.('public.example', { all: true }, (error, addresses) => {
        if (error) reject(error);
        else {
          expect(addresses).toEqual([publicV4]);
          resolveLookup();
        }
      });
    });
  });

  it('rejects a socket connected to an address other than the validated answer', async () => {
    const transport = fakeTransport({
      'https://public.example/': { remoteAddress: '10.0.0.8' },
    });
    const fetch = createOutboundFetch({
      resolve: async () => [publicV4],
      request: transport.request,
    });

    await expect(fetch('https://public.example/')).rejects.toThrow('unvalidated destination');
  });

  it('revalidates and blocks a public-to-private redirect before the second request', async () => {
    const resolve = jest.fn(async (hostname: string) =>
      hostname === 'public.example' ? [publicV4] : [{ address: '169.254.169.254', family: 4 as const }],
    );
    const transport = fakeTransport({
      'https://public.example/': {
        status: 302,
        headers: { location: 'http://metadata.example/latest/meta-data/' },
      },
    });
    const fetch = createOutboundFetch({ resolve, request: transport.request });

    await expect(fetch('https://public.example/')).rejects.toThrow('non-public');
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(transport.requests.map(({ url }) => url)).toEqual(['https://public.example/']);
  });

  it('follows public redirects and validates every hop', async () => {
    const resolve = jest.fn(async (_hostname: string) => [publicV4]);
    const transport = fakeTransport({
      'https://first.example/start': {
        status: 301,
        headers: { location: 'https://second.example/final' },
      },
      'https://second.example/final': { body: 'final' },
    });
    const fetch = createOutboundFetch({ resolve, request: transport.request });

    await expect((await fetch('https://first.example/start')).text()).resolves.toBe('final');
    expect(resolve.mock.calls.map(([hostname]) => hostname)).toEqual(['first.example', 'second.example']);
    expect(transport.requests).toHaveLength(2);
  });

  it.each(['file:///etc/passwd', 'ftp://public.example/file', 'https://user:pass@public.example/'])(
    'rejects disallowed destination %s',
    async (url) => {
      const fetch = createOutboundFetch({ resolve: async () => [publicV4] });
      await expect(fetch(url)).rejects.toBeInstanceOf(OutboundUrlError);
    },
  );

  it('only allows read-only HTTP methods', async () => {
    const fetch = createOutboundFetch({ resolve: async () => [publicV4] });
    await expect(fetch('https://public.example/', { method: 'POST' })).rejects.toThrow('GET and HEAD');
  });
});
