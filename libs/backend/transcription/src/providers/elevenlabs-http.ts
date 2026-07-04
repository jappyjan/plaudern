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
 * node:https rather than global fetch.
 *
 * Rationale for avoiding fetch: undici (Node's fetch) aborts a request
 * after its 300s `headersTimeout` when no response headers have arrived, but
 * ElevenLabs computes the whole transcription before responding and a long
 * recording can run past five minutes — which would surface as a bare "fetch
 * failed" while the model keeps working. node:http/https has no headers
 * timeout; `timeoutMs` is a socket-inactivity cap, and since ElevenLabs is
 * silent while transcribing that bounds the total wait.
 */
export function postMultipartForJson<T>(
  url: string,
  fields: MultipartTextField[],
  file: MultipartFilePart,
  headers: Record<string, string>,
  timeoutMs: number,
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
            reject(new Error(`ElevenLabs error ${status}: ${text.slice(0, 500)}`));
            return;
          }
          try {
            resolve(JSON.parse(text) as T);
          } catch (err) {
            reject(new Error(`ElevenLabs returned invalid JSON: ${(err as Error).message}`));
          }
        });
      },
    );
    req.setTimeout(timeoutMs, () =>
      req.destroy(new Error(`ElevenLabs request timed out after ${timeoutMs}ms`)),
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
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
