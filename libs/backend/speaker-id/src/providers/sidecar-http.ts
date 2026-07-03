import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

/**
 * POST JSON to the ML sidecar and parse the JSON response.
 *
 * Deliberately node:http, not global fetch: undici (Node's fetch) aborts a
 * request after its 300s `headersTimeout` if no response headers have arrived,
 * but the sidecar computes the whole diarization/transcription before sending
 * headers, and CPU inference on long audio routinely runs past five minutes —
 * which surfaced as a bare "fetch failed" while the sidecar kept working.
 * node:http has no headers timeout; `timeoutMs` is a socket-inactivity cap, and
 * since the sidecar is silent while computing that bounds the total wait.
 *
 * ponytail: duplicated in libs/backend/transcription/src/providers — extract to
 * a shared lib if a third caller appears.
 */
export function postJsonToSidecar<T>(
  url: string,
  body: unknown,
  token: string,
  timeoutMs: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const u = new URL(url);
    const payload = JSON.stringify(body);
    const request = u.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c as Buffer));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            reject(new Error(`sidecar error ${status}: ${text.slice(0, 500)}`));
            return;
          }
          try {
            resolve(JSON.parse(text) as T);
          } catch (err) {
            reject(new Error(`sidecar returned invalid JSON: ${(err as Error).message}`));
          }
        });
      },
    );
    req.setTimeout(timeoutMs, () =>
      req.destroy(new Error(`sidecar request timed out after ${timeoutMs}ms`)),
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}
