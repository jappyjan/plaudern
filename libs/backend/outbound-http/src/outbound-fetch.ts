import { lookup } from 'node:dns/promises';
import { request as httpRequest, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { Readable } from 'node:stream';

const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export class OutboundUrlError extends Error {}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

type Resolve = (hostname: string) => Promise<ResolvedAddress[]>;
type Request = (
  url: URL,
  options: RequestOptions,
  callback: (response: import('node:http').IncomingMessage) => void,
) => import('node:http').ClientRequest;

const blockedAddresses = new BlockList();

for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['192.88.99.0', 24],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blockedAddresses.addSubnet(network, prefix, 'ipv4');
}

for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
  ['5f00::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  blockedAddresses.addSubnet(network, prefix, 'ipv6');
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  return family !== 0 && !blockedAddresses.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

function hostnameWithoutBrackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

async function defaultResolve(hostname: string): Promise<ResolvedAddress[]> {
  return lookup(hostname, { all: true, verbatim: true }) as Promise<ResolvedAddress[]>;
}

function defaultRequest(url: URL, options: RequestOptions, callback: Parameters<Request>[2]) {
  return (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, options, callback);
}

async function resolvePublic(url: URL, resolve: Resolve): Promise<ResolvedAddress[]> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new OutboundUrlError('only HTTP and HTTPS destinations are allowed');
  }
  if (url.username || url.password) throw new OutboundUrlError('URL credentials are not allowed');

  const hostname = hostnameWithoutBrackets(url.hostname);
  const literalFamily = isIP(hostname);
  const addresses = literalFamily
    ? [{ address: hostname, family: literalFamily as 4 | 6 }]
    : await resolve(hostname);

  if (addresses.length === 0) throw new OutboundUrlError('destination did not resolve');
  if (addresses.some(({ address, family }) => isIP(address) !== family || !isPublicAddress(address))) {
    throw new OutboundUrlError('destination resolves to a non-public address');
  }
  return addresses;
}

async function abortable<T>(promise: Promise<T>, signal?: AbortSignal | null): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) throw signal.reason;

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function pinnedLookup(addresses: ResolvedAddress[]): NonNullable<RequestOptions['lookup']> {
  return (_hostname, options, callback) => {
    const family = typeof options === 'object' ? options.family : undefined;
    const candidates =
      family === 4 || family === 6 ? addresses.filter((entry) => entry.family === family) : addresses;
    const selected = candidates[0];
    if (!selected) {
      callback(new OutboundUrlError(`destination has no validated IPv${String(family)} address`), '', 0);
      return;
    }

    if (typeof options === 'object' && options.all) {
      (callback as unknown as (error: null, entries: ResolvedAddress[]) => void)(null, candidates);
      return;
    }
    callback(null, selected.address, selected.family);
  };
}

function addressMatches(actual: string, expected: ResolvedAddress[]): boolean {
  const family = isIP(actual);
  if (family === 0) return false;
  const allowed = new BlockList();
  for (const entry of expected) allowed.addAddress(entry.address, entry.family === 4 ? 'ipv4' : 'ipv6');
  return allowed.check(actual, family === 4 ? 'ipv4' : 'ipv6');
}

function assertConnectedToValidatedAddress(
  response: import('node:http').IncomingMessage,
  addresses: ResolvedAddress[],
): void {
  const actual = response.socket.remoteAddress;
  if (!actual || !isPublicAddress(actual) || !addressMatches(actual, addresses)) {
    response.destroy();
    throw new OutboundUrlError('connection reached an unvalidated destination address');
  }
}

function responseHeaders(headers: import('node:http').IncomingHttpHeaders): Headers {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) value.forEach((entry) => result.append(name, entry));
    else if (value !== undefined) result.set(name, value);
  }
  return result;
}

export function createOutboundFetch(dependencies: { resolve?: Resolve; request?: Request } = {}) {
  const resolve = dependencies.resolve ?? defaultResolve;
  const request = dependencies.request ?? defaultRequest;

  return async function outboundFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
    const method = (init.method ?? 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      throw new OutboundUrlError('outbound URL policy only permits GET and HEAD requests');
    }

    let url: URL;
    try {
      url = input instanceof URL ? new URL(input) : new URL(input);
    } catch {
      throw new OutboundUrlError('invalid destination URL');
    }

    for (let redirects = 0; ; redirects += 1) {
      const addresses = await abortable(resolvePublic(url, resolve), init.signal);
      const response = await new Promise<import('node:http').IncomingMessage>((resolveResponse, reject) => {
        const req = request(
          url,
          {
            method,
            headers: Object.fromEntries(new Headers(init.headers).entries()),
            lookup: pinnedLookup(addresses),
            signal: init.signal ?? undefined,
          },
          resolveResponse,
        );
        req.once('error', reject);
        req.end();
      });

      assertConnectedToValidatedAddress(response, addresses);

      const status = response.statusCode ?? 0;
      const location = response.headers.location;
      if (REDIRECT_STATUSES.has(status) && location) {
        response.destroy();
        if (redirects >= MAX_REDIRECTS) throw new OutboundUrlError('too many redirects');
        try {
          url = new URL(location, url);
        } catch {
          throw new OutboundUrlError('redirect has an invalid destination URL');
        }
        continue;
      }

      const body = method === 'HEAD' || status === 204 || status === 304 ? null : Readable.toWeb(response);
      return new Response(body as ReadableStream<Uint8Array> | null, {
        status,
        statusText: response.statusMessage,
        headers: responseHeaders(response.headers),
      });
    }
  };
}

export const outboundFetch = createOutboundFetch();
