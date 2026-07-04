import { execFile } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { Injectable } from '@nestjs/common';
import { StorageService } from '@plaudern/storage';

const execFileAsync = promisify(execFile);

export interface ConcatResult {
  /** The merged audio, re-encoded to a single format. */
  bytes: Buffer;
  contentType: string;
  /** Duration of each input in order — drives the transcript segment offsets. */
  durationsSeconds: number[];
}

/**
 * Concatenates several stored audio objects into one file. Sources may be in
 * different containers/codecs (mp3, wav, opus, m4a, ...), so the output is
 * always re-encoded. Tests override the DI token with a fake, mirroring the
 * CLIP_EXTRACTOR pattern.
 */
export interface AudioConcatenator {
  concat(storageKeys: string[]): Promise<ConcatResult>;
}

export const AUDIO_CONCATENATOR = Symbol('AUDIO_CONCATENATOR');

/**
 * ffmpeg-based concatenator: downloads each source once, probes its duration
 * with ffprobe, then runs a single ffmpeg pass that normalizes every input to
 * 44.1 kHz stereo s16 and concatenates them into an mp3. The output is
 * written to a temp file (never stdout — a multi-hour merge would blow
 * execFile's maxBuffer). Requires the `ffmpeg` binary (installed in the API
 * image alongside ffprobe).
 */
@Injectable()
export class FfmpegAudioConcatenator implements AudioConcatenator {
  constructor(private readonly storage: StorageService) {}

  async concat(storageKeys: string[]): Promise<ConcatResult> {
    const dir = await mkdtemp(join(tmpdir(), 'plaudern-merge-'));
    try {
      const inputs: string[] = [];
      const durationsSeconds: number[] = [];
      for (const [index, storageKey] of storageKeys.entries()) {
        const path = join(dir, `in-${index}`);
        await pipeline(await this.storage.getObjectStream(storageKey), createWriteStream(path));
        inputs.push(path);
        durationsSeconds.push(await probeDurationSeconds(path));
      }

      const output = join(dir, 'merged.mp3');
      const normalize = inputs.map(
        (_, i) =>
          `[${i}:a]aresample=44100,aformat=sample_fmts=s16:channel_layouts=stereo[a${i}]`,
      );
      const labels = inputs.map((_, i) => `[a${i}]`).join('');
      const filterComplex = `${normalize.join(';')};${labels}concat=n=${inputs.length}:v=0:a=1[out]`;

      await execFileAsync('ffmpeg', [
        '-nostdin',
        '-loglevel',
        'error',
        ...inputs.flatMap((path) => ['-i', path]),
        '-filter_complex',
        filterComplex,
        '-map',
        '[out]',
        '-codec:a',
        'libmp3lame',
        '-q:a',
        '4',
        output,
      ]);

      return { bytes: await readFile(output), contentType: 'audio/mpeg', durationsSeconds };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

async function probeDurationSeconds(path: string): Promise<number> {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'csv=p=0',
    path,
  ]);
  const duration = Number.parseFloat(stdout.trim());
  if (!Number.isFinite(duration) || duration < 0) {
    throw new Error(`ffprobe returned no duration for ${path}`);
  }
  return duration;
}
