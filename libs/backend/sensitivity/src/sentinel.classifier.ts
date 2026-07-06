import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  SensitivityDetection,
  SensitivitySpan,
  SensitivityTier,
} from '@plaudern/contracts';
import { detectDeterministic, foldSpans } from './detectors';
import {
  SENTINEL_LLM_PROVIDER,
  type SentinelClassifyInput,
  type SentinelLlmProvider,
} from './sentinel.provider';

export interface SentinelClassification {
  detectedTier: SensitivityTier;
  spans: SensitivitySpan[];
  detections: SensitivityDetection[];
  llmClassified: boolean;
}

/**
 * Combines the always-on deterministic detectors with the OPTIONAL LLM
 * classifier (JJ-21). The deterministic pass always runs (no key). The LLM pass
 * runs only when its provider is enabled; its verbatim findings are located in
 * the transcript to build mask spans, then folded together with the regex spans
 * (most-sensitive tier wins). A failing LLM call degrades to deterministic-only
 * rather than failing the whole classification.
 */
@Injectable()
export class SentinelClassifier {
  private readonly logger = new Logger(SentinelClassifier.name);

  constructor(
    @Inject(SENTINEL_LLM_PROVIDER)
    private readonly llm: SentinelLlmProvider,
  ) {}

  async classify(input: SentinelClassifyInput): Promise<SentinelClassification> {
    const deterministic = detectDeterministic(input.transcript);
    let spans: SensitivitySpan[] = deterministic.spans;
    let llmClassified = false;

    if (this.llm.enabled) {
      try {
        const result = await this.llm.classify(input);
        const located = locateFindings(input.transcript, result.findings);
        spans = [...spans, ...located];
        llmClassified = true;
      } catch (err) {
        // Degrade gracefully — deterministic detection still stands.
        this.logger.warn(`sentinel LLM classifier failed, using detectors only: ${(err as Error).message}`);
      }
    }

    const folded = foldSpans(spans);
    return {
      detectedTier: folded.tier,
      spans: folded.spans,
      detections: folded.detections,
      llmClassified,
    };
  }
}

/** Turn verbatim LLM findings into char-offset spans by locating each quote. */
export function locateFindings(
  transcript: string,
  findings: { category: SensitivitySpan['category']; quote: string }[],
): SensitivitySpan[] {
  const spans: SensitivitySpan[] = [];
  for (const finding of findings) {
    const quote = finding.quote.trim();
    if (quote.length === 0) continue;
    const idx = transcript.indexOf(quote);
    if (idx < 0) continue; // hallucinated / non-verbatim — skip, never mask blindly.
    spans.push({ start: idx, end: idx + quote.length, category: finding.category });
  }
  return spans;
}
