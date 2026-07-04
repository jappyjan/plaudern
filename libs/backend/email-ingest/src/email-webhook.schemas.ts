import { z } from 'zod';

/**
 * The webhook accepts a raw MIME email in one of two shapes (plan §2):
 *
 *  - `Content-Type: message/rfc822` (or `text/plain`) — the request body IS
 *    the raw MIME source, forwarded byte-for-byte by a relay (e.g. AWS SES ->
 *    Lambda). Handled upstream by an `express.raw()` middleware in `main.ts`
 *    scoped to those content types, so it never reaches this schema — the
 *    controller passes the Buffer straight to `mailparser`.
 *  - `Content-Type: application/json` — a SendGrid/SES-style wrapper carrying
 *    the raw MIME as a string field, matching how AWS SES delivers message
 *    content (base64-encoded) via SNS/Lambda bridges. `isBase64` defaults to
 *    true since that's the common case; set it to false to pass raw text
 *    directly (e.g. a relay that already decoded it).
 */
export const emailWebhookJsonBodySchema = z.object({
  raw: z.string().min(1),
  isBase64: z.boolean().default(true),
});
export type EmailWebhookJsonBody = z.infer<typeof emailWebhookJsonBodySchema>;
