import { Injectable } from '@nestjs/common';
import { TranscriptionService } from '@plaudern/transcription';
import { SpeakerIdService } from '@plaudern/speaker-id';
import { AudioSourceAdapter } from './audio-source.adapter';

/**
 * Direct audio upload from any client — and the hardware-free test seam that
 * proves the whole inbox+transcription slice (plan §6, Path A/B).
 */
@Injectable()
export class GenericAudioAdapter extends AudioSourceAdapter {
  readonly sourceType = 'audio' as const;

  constructor(transcription: TranscriptionService, speakerId: SpeakerIdService) {
    super(transcription, speakerId);
  }
}
