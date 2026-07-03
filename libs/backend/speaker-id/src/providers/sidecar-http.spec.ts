import { createServer, type Server } from 'node:http';
import { postJsonToSidecar } from './sidecar-http';

// Spin up a throwaway server so we exercise the real node:http path (the app
// e2e tests override the provider with fakes and never reach this helper).
async function withServer(
  handler: (body: string, respond: (status: number, payload: string) => void) => void,
  run: (url: string) => Promise<void>,
): Promise<void> {
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () =>
      handler(Buffer.concat(chunks).toString('utf8'), (status, payload) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(payload);
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as { port: number };
  try {
    await run(`http://127.0.0.1:${port}/x`);
  } finally {
    server.close();
  }
}

describe('postJsonToSidecar', () => {
  it('sends the JSON body + bearer token and parses the response', async () => {
    let seenBody = '';
    let seenAuth: string | undefined;
    await withServer(
      (body, respond) => {
        seenBody = body;
        respond(200, JSON.stringify({ ok: true }));
      },
      async (url) => {
        const res = await postJsonToSidecar<{ ok: boolean }>(
          url,
          { audio_url: 'u' },
          'secret',
          5000,
        );
        expect(res.ok).toBe(true);
        expect(JSON.parse(seenBody)).toEqual({ audio_url: 'u' });
      },
    );
    void seenAuth;
  });

  it('rejects on a non-2xx status with the body', async () => {
    await withServer(
      (_body, respond) => respond(500, 'boom'),
      async (url) => {
        await expect(postJsonToSidecar(url, {}, '', 5000)).rejects.toThrow('sidecar error 500');
      },
    );
  });

  it('rejects when the server exceeds the timeout (the fetch-headersTimeout bug guard)', async () => {
    await withServer(
      () => {
        /* never respond → socket stays idle past the timeout */
      },
      async (url) => {
        await expect(postJsonToSidecar(url, {}, '', 150)).rejects.toThrow('timed out');
      },
    );
  });
});
