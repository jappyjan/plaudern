import { execFile } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { Injectable, Logger } from '@nestjs/common';
import { StorageService } from '@plaudern/storage';

const execFileAsync = promisify(execFile);

export interface ClipSegment {
  start: number;
  end: number;
}

export interface ClipSpeaker {
  /** Canonical per-recording label, e.g. SPEAKER_00. */
  label: string;
  /** Timed ranges this speaker spoke. */
  segments: ClipSegment[];
}

export interface VoiceprintClip {
  label: string;
  /** 16 kHz mono WAV of the speaker's cleanest speech. */
  wav: Buffer;
}

/**
 * Slices one clean single-speaker clip per speaker out of a recording, for
 * voiceprint enrollment. pyannoteAI creates a voiceprint from clean
 * single-speaker audio but cannot cut a speaker out of a multi-speaker
 * recording, so we do it ourselves. Tests override the DI token with a fake.
 */
export interface ClipExtractor {
  extract(storageKey: string, speakers: ClipSpeaker[], maxSeconds: number): Promise<VoiceprintClip[]>;
}

export const CLIP_EXTRACTOR = Symbol('CLIP_EXTRACTOR');

/**
 * ffmpeg-based extractor: downloads the recording from storage once, then per
 * speaker trims their longest segments (up to `maxSeconds`, played back in
 * chronological order) and concatenates them into a 16 kHz mono WAV. Requires
 * the `ffmpeg` binary (installed in the API image). Best-effort per speaker: a
 * clip that fails to render is skipped rather than failing the batch.
 */
@Injectable()
export class FfmpegClipExtractor implements ClipExtractor {
  private readonly logger = new Logger(FfmpegClipExtractor.name);

  constructor(private readonly storage: StorageService) {}

  async extract(
    storageKey: string,
    speakers: ClipSpeaker[],
    maxSeconds: number,
  ): Promise<VoiceprintClip[]> {
    const dir = await mkdtemp(join(tmpdir(), 'plaudern-clips-'));
    try {
      const audioPath = join(dir, 'audio');
      await pipeline(await this.storage.getObjectStream(storageKey), createWriteStream(audioPath));

      const clips: VoiceprintClip[] = [];
      for (const speaker of speakers) {
        const chosen = pickSegments(speaker.segments, maxSeconds);
        if (chosen.length === 0) continue;
        try {
          clips.push({ label: speaker.label, wav: await this.render(audioPath, chosen) });
        } catch (err) {
          this.logger.warn(
            `clip extraction failed for ${speaker.label}: ${(err as Error).message}`,
          );
        }
      }
      return clips;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /** Trim `segments` from the file and concat them into a WAV on stdout. */
  private async render(audioPath: string, segments: ClipSegment[]): Promise<Buffer> {
    const trims = segments.map(
      (seg, i) => `[0:a]atrim=start=${seg.start}:end=${seg.end},asetpts=PTS-STARTPTS[a${i}]`,
    );
    const labels = segments.map((_, i) => `[a${i}]`).join('');
    const filterComplex = `${trims.join(';')};${labels}concat=n=${segments.length}:v=0:a=1[out]`;

    const { stdout } = await execFileAsync(
      'ffmpeg',
      // prettier-ignore
      [
        '-nostdin', '-loglevel', 'error', '-i', audioPath,
        '-filter_complex', filterComplex,
        '-map', '[out]', '-ar', '16000', '-ac', '1', '-f', 'wav', 'pipe:1',
      ],
      { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 },
    );
    return stdout;
  }
}

/**
 * Prefer the longest segments (cleaner, less turn-boundary noise) up to the
 * cap, then play them back in chronological order.
 */
export function pickSegments(segments: ClipSegment[], maxSeconds: number): ClipSegment[] {
  const ranges = [...segments].sort((a, b) => b.end - b.start - (a.end - a.start));
  const chosen: ClipSegment[] = [];
  let total = 0;
  for (const seg of ranges) {
    if (total >= maxSeconds) break;
    chosen.push(seg);
    total += Math.max(0, seg.end - seg.start);
  }
  return chosen.sort((a, b) => a.start - b.start);
}
