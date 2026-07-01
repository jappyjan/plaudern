import { Injectable } from '@nestjs/common';
import type {
  TranscriptionInput,
  TranscriptionProvider,
  TranscriptionResult,
} from '../transcription.provider';

/**
 * Deterministic stub used for CI/offline verification (plan §5/§6). Drains the
 * stream (so the storage read path is genuinely exercised) and returns fixed text.
 */
@Injectable()
export class LocalStubProvider implements TranscriptionProvider {
  readonly id = 'local-stub';

  async transcribe(input: TranscriptionInput): Promise<TranscriptionResult> {
    let bytes = 0;
    for await (const chunk of input.stream) {
      bytes += (chunk as Buffer).length;
    }
    return {
      text: `[stub transcription of ${bytes} bytes, ${input.contentType}]`,
      language: 'en',
    };
  }
}
