import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

export interface MultipartTextField {
  name: string;
  value: string;
}

export interface MultipartFilePart {
  name: string;
  filename: string;
  contentType: string;
  bytes: Buffer;
}

/**
 * POST a multipart/form-data request and parse the JSON response, over
 * node:https rather than global fetch. Shared by every transcription provider
 * (hosted ElevenLabs Scribe, self-hosted Whisper-compatible servers, …).
 *
 * Rationale for avoiding fetch: undici (Node's fetch) aborts a request
 * after its 300s `headersTimeout` when no response headers have arrived, but a
 * transcription backend computes the whole transcript before responding and a
 * long recording can run past five minutes — which would surface as a bare
 * "fetch failed" while the model keeps working. node:http/https has no
 * headers timeout; `timeoutMs` is a socket-inactivity cap, and since these
 * backends are silent while transcribing that bounds the total wait.
 *
 * `providerLabel` is only used to make error messages identify which backend
 * failed (e.g. "ElevenLabs error 500: …" vs "Whisper error 500: …").
 */
export function postMultipartForJson<T>(
  url: string,
  fields: MultipartTextField[],
  file: MultipartFilePart,
  headers: Record<string, string>,
  timeoutMs: number,
  providerLabel = 'transcription request',
): Promise<T> {
  const boundary = `----plaudern-${randomUUID()}`;
  const body = buildMultipartBody(boundary, fields, file);

  return new Promise<T>((resolve, reject) => {
    const u = new URL(url);
    const request = u.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = request(
      {
        hostname: u.hostname,
        port: u.port,
        path: `${u.pathname}${u.search}`,
        method: 'POST',
        headers: {
          ...headers,
          'content-type': `multipart/form-data; boundary=${boundary}`,
          'content-length': body.length,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c as Buffer));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            reject(new Error(`${providerLabel} error ${status}: ${text.slice(0, 500)}`));
            return;
          }
          try {
            resolve(JSON.parse(text) as T);
          } catch (err) {
            reject(
              new Error(`${providerLabel} returned invalid JSON: ${(err as Error).message}`),
            );
          }
        });
      },
    );
    req.setTimeout(timeoutMs, () =>
      req.destroy(new Error(`${providerLabel} timed out after ${timeoutMs}ms`)),
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Download the audio bytes from a presigned internal storage URL. Shared by
 * every transcription provider that pulls the recording before sending it to
 * a backend (hosted ElevenLabs, self-hosted Whisper, …).
 */
export async function downloadBytes(url: string, timeoutMs: number): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`could not download audio: ${res.status}`);
    }
    return Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

/** Assemble the RFC 7578 body: text fields first, then the single file part. */
function buildMultipartBody(
  boundary: string,
  fields: MultipartTextField[],
  file: MultipartFilePart,
): Buffer {
  const parts: Buffer[] = [];
  for (const field of fields) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="${field.name}"\r\n\r\n` +
          `${field.value}\r\n`,
      ),
    );
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="${file.name}"; filename="${sanitizeFilename(file.filename)}"\r\n` +
        `Content-Type: ${file.contentType}\r\n\r\n`,
    ),
  );
  parts.push(file.bytes);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return Buffer.concat(parts);
}

/** Strip quotes and control characters that would break the header line. */
function sanitizeFilename(name: string): string {
  // eslint-disable-next-line no-control-regex
  return name.replace(/["\r\n\x00-\x1f]/g, '_') || 'audio';
}
