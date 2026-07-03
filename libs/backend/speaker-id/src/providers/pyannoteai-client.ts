import { Logger } from '@nestjs/common';

/** A stored voiceprint keyed by the label /identify should report on a match. */
export interface PyannoteAiVoiceprint {
  label: string;
  voiceprint: string;
}

export interface PyannoteAiSegment {
  start: number;
  end: number;
  speaker: string;
}

export interface PyannoteAiDiarization {
  durationSeconds: number;
  segments: PyannoteAiSegment[];
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Thin client for the hosted pyannoteAI API (https://api.pyannote.ai/v1).
 *
 * Every operation is an async job: POST returns a `jobId`, and the result is
 * read by polling `GET /jobs/{id}` until it succeeds. Unlike the self-hosted
 * sidecar (which holds one long request open, forcing node:http — see
 * sidecar-http.ts), each pyannoteAI call returns headers immediately, so global
 * fetch with a per-request timeout is fine here.
 */
export class PyannoteAiClient {
  private readonly logger = new Logger(PyannoteAiClient.name);

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly model: string,
    private readonly pollIntervalMs: number,
    private readonly timeoutMs: number,
  ) {}

  /** Diarize with no prior speakers: who-spoke-when, generic SPEAKER_xx labels. */
  async diarize(audioUrl: string): Promise<PyannoteAiDiarization> {
    const jobId = await this.submit('/diarize', { url: audioUrl, model: this.model });
    const output = await this.poll(jobId);
    return this.parseDiarization(output);
  }

  /**
   * Diarize AND match against known voiceprints in one call. Matched speakers
   * are reported under the voiceprint's `label`; everyone else keeps a generic
   * SPEAKER_xx label. Requires the precision-2 model.
   */
  async identify(
    audioUrl: string,
    voiceprints: PyannoteAiVoiceprint[],
    threshold: number,
  ): Promise<PyannoteAiDiarization> {
    const jobId = await this.submit('/identify', {
      url: audioUrl,
      model: this.model,
      voiceprints,
      matching: { exclusive: true, threshold },
    });
    const output = await this.poll(jobId);
    return this.parseDiarization(output);
  }

  /** Enroll a voiceprint from a clean, single-speaker clip. Returns the opaque token. */
  async voiceprint(audioUrl: string): Promise<string> {
    const jobId = await this.submit('/voiceprint', { url: audioUrl, model: this.model });
    const output = await this.poll(jobId);
    const voiceprint = output?.voiceprint;
    if (typeof voiceprint !== 'string' || voiceprint.length === 0) {
      throw new Error('pyannoteAI voiceprint job returned no voiceprint');
    }
    return voiceprint;
  }

  private headers(): Record<string, string> {
    return { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` };
  }

  private async submit(path: string, body: unknown): Promise<string> {
    const res = await this.fetchWithTimeout(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`pyannoteAI ${path} failed ${res.status}: ${(await res.text()).slice(0, 500)}`);
    }
    const json = (await res.json()) as { jobId?: string };
    if (!json.jobId) throw new Error(`pyannoteAI ${path} returned no jobId`);
    return json.jobId;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async poll(jobId: string): Promise<any> {
    const deadline = Date.now() + this.timeoutMs;
    for (;;) {
      const res = await this.fetchWithTimeout(`${this.baseUrl}/jobs/${jobId}`, {
        headers: this.headers(),
      });
      if (!res.ok) {
        throw new Error(`pyannoteAI jobs/${jobId} failed ${res.status}`);
      }
      const json = (await res.json()) as {
        status?: string;
        output?: unknown;
        error?: unknown;
        message?: unknown;
      };
      const status = json.status;
      if (status === 'succeeded' || status === 'completed') return json.output;
      if (status === 'failed' || status === 'canceled' || status === 'cancelled') {
        const detail = json.error ?? json.message ?? '';
        throw new Error(`pyannoteAI job ${jobId} ${status}: ${JSON.stringify(detail)}`);
      }
      if (Date.now() > deadline) {
        throw new Error(`pyannoteAI job ${jobId} timed out after ${this.timeoutMs}ms`);
      }
      await sleep(this.pollIntervalMs);
    }
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * /diarize returns `output.diarization`; /identify returns
   * `output.identification`. Both are arrays of {start,end,speaker}. Accept
   * either key so one parser serves both.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private parseDiarization(output: any): PyannoteAiDiarization {
    const raw = output?.identification ?? output?.diarization;
    if (!Array.isArray(raw)) {
      throw new Error('pyannoteAI job output had no diarization/identification array');
    }
    let duration = 0;
    const segments: PyannoteAiSegment[] = raw.map((s) => {
      const start = Number(s.start);
      const end = Number(s.end);
      duration = Math.max(duration, end);
      return { start, end, speaker: String(s.speaker) };
    });
    return { durationSeconds: Number(output?.duration ?? duration), segments };
  }
}
