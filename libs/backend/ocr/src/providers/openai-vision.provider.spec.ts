import { ConfigService } from '@nestjs/config';
import { OpenAiVisionOcrProvider } from './openai-vision.provider';

function providerWith(env: Record<string, string>): OpenAiVisionOcrProvider {
  const config = {
    get: <T>(key: string, def?: T): T => (env[key] as unknown as T) ?? (def as T),
  } as unknown as ConfigService;
  return new OpenAiVisionOcrProvider(config);
}

describe('OpenAiVisionOcrProvider gating', () => {
  it('is DISABLED by default (no key, not opted in)', () => {
    expect(providerWith({}).enabled).toBe(false);
  });

  it('is enabled when OCR_API_KEY is set', () => {
    expect(providerWith({ OCR_API_KEY: 'sk-vision' }).enabled).toBe(true);
  });

  it('is enabled when OCR_ENABLED=true (keyless local vision gateway)', () => {
    expect(providerWith({ OCR_ENABLED: 'true' }).enabled).toBe(true);
  });

  it('throws a helpful error when recognize() runs while disabled', async () => {
    await expect(
      providerWith({}).recognize({ imageDataUrl: 'data:image/png;base64,AAAA', contentType: 'image/png' }),
    ).rejects.toThrow(/OCR is disabled/);
  });
});
