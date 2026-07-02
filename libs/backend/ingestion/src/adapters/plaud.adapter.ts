import { Injectable } from '@nestjs/common';
import { TranscriptionService } from '@plaudern/transcription';
import { SpeakerIdService } from '@plaudern/speaker-id';
import { AudioSourceAdapter } from './audio-source.adapter';

/**
 * Audio pulled off a Plaud device via the iOS SDK's manual path. Identical to
 * generic audio at the ingestion core; the app just tags it `plaud` and derives
 * the idempotency key from the Plaud file id + device serial (plan §2/§4).
 */
@Injectable()
export class PlaudAdapter extends AudioSourceAdapter {
  readonly sourceType = 'plaud' as const;

  constructor(transcription: TranscriptionService, speakerId: SpeakerIdService) {
    super(transcription, speakerId);
  }
}
