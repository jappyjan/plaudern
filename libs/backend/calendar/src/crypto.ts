import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Symmetric encryption for stored calendar feed URLs. A secret ICS URL grants
 * read access to the whole calendar, so it must not sit in plain DB
 * dumps/backups — but sync needs the raw URL back, so hashing is impossible.
 * Same scheme and format as plaud-sync: `v1:<ivB64>:<tagB64>:<dataB64>`.
 */
const VERSION = 'v1';

function deriveKey(secret: string): Buffer {
  return createHash('sha256').update(secret).digest();
}

export function encryptSecret(plain: string, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(secret), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64'), tag.toString('base64'), data.toString('base64')].join(
    ':',
  );
}

export function decryptSecret(ciphertext: string, secret: string): string {
  const [version, ivB64, tagB64, dataB64] = ciphertext.split(':');
  if (version !== VERSION || !ivB64 || !tagB64 || !dataB64) {
    throw new Error('unrecognized ciphertext format');
  }
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(secret), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}
