import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { EmailWebhookController } from './email-webhook.controller';

type Fakes = {
  webhook: { handleRawEmail: jest.Mock };
  config: { get: jest.Mock };
};

function build(secret: string | undefined): { controller: EmailWebhookController; fakes: Fakes } {
  const fakes: Fakes = {
    webhook: { handleRawEmail: jest.fn().mockResolvedValue({ inboxItemId: 'item-1', skipped: false }) },
    config: { get: jest.fn().mockReturnValue(secret ?? '') },
  };
  const controller = new EmailWebhookController(fakes.webhook as never, fakes.config as never);
  return { controller, fakes };
}

describe('EmailWebhookController', () => {
  it('503s when EMAIL_WEBHOOK_SECRET is not configured server-side', async () => {
    const { controller } = build(undefined);
    await expect(controller.receive('anything', 'raw mime')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('rejects a missing or wrong secret', async () => {
    const { controller } = build('correct-secret');
    await expect(controller.receive(undefined, 'raw mime')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await expect(controller.receive('wrong-secret', 'raw mime')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('accepts a raw MIME string body when the secret matches', async () => {
    const { controller, fakes } = build('correct-secret');
    const result = await controller.receive('correct-secret', 'RAW MIME SOURCE');
    expect(result).toEqual({ inboxItemId: 'item-1', skipped: false });
    expect(fakes.webhook.handleRawEmail).toHaveBeenCalledWith('RAW MIME SOURCE');
  });

  it('accepts a raw MIME Buffer body (message/rfc822, captured by express.raw())', async () => {
    const { controller, fakes } = build('correct-secret');
    const buf = Buffer.from('RAW MIME SOURCE');
    await controller.receive('correct-secret', buf);
    expect(fakes.webhook.handleRawEmail).toHaveBeenCalledWith(buf);
  });

  it('decodes a base64 JSON wrapper by default', async () => {
    const { controller, fakes } = build('correct-secret');
    const raw = Buffer.from('RAW MIME SOURCE').toString('base64');
    await controller.receive('correct-secret', { raw });
    const passed = fakes.webhook.handleRawEmail.mock.calls[0][0] as Buffer;
    expect(passed.toString('utf8')).toBe('RAW MIME SOURCE');
  });

  it('passes a JSON wrapper through as-is when isBase64 is false', async () => {
    const { controller, fakes } = build('correct-secret');
    await controller.receive('correct-secret', { raw: 'RAW MIME SOURCE', isBase64: false });
    expect(fakes.webhook.handleRawEmail).toHaveBeenCalledWith('RAW MIME SOURCE');
  });

  it('rejects an unrecognized body shape', async () => {
    const { controller } = build('correct-secret');
    await expect(controller.receive('correct-secret', 42)).rejects.toThrow();
  });
});
