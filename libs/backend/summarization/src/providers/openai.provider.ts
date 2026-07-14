import { Injectable } from '@nestjs/common';
import { AiConfigService, OpenAiChatClient } from '@plaudern/ai-config';
import { summaryLayoutSchema, type SummaryLayout } from '@plaudern/contracts';
import type {
  SummarizationInput,
  SummarizationProvider,
  SummarizationResult,
} from '../summarization.provider';

/** Human-facing description of every layout, injected into the prompt. */
const LAYOUT_GUIDE: Record<SummaryLayout, string> = {
  meeting:
    'a meeting/standup with multiple participants: use sections for Attendees, Key points, Decisions, and a `- [ ]` checklist of Action items (attribute each to a speaker). A mermaid diagram is welcome when it clarifies a flow or timeline.',
  interview:
    'an interview or Q&A: summarize the main questions and answers, optionally as `#### Question` / answer pairs.',
  lecture:
    'a lecture, talk or tutorial: an outline of topics with key concepts; a mermaid `mindmap` or `flowchart` is often useful.',
  conversation:
    'a casual multi-person conversation: a short narrative plus the notable points raised by each speaker.',
  note: 'a personal voice memo or single-speaker note: a tight TL;DR followed by a few bullet points.',
  todo: 'primarily tasks/reminders: a `- [ ]` checklist of the todos, grouped if helpful.',
  general: 'anything that does not fit the others: a concise summary with sensible headings.',
};

/**
 * Summarizes via an OpenAI-compatible `/chat/completions` endpoint. The
 * endpoint/model come from the user's DB-backed AI config (`@plaudern/ai-config`,
 * capability `summarization`) — any provider exposing the OpenAI schema works
 * (DeepSeek, OpenAI, OpenRouter, a local Ollama/llama.cpp server, …). The
 * transcript never leaves our infra except to that configured LLM endpoint; no
 * audio is sent, only text.
 */
@Injectable()
export class OpenAiSummarizationProvider implements SummarizationProvider {
  readonly id = 'openai';

  constructor(
    private readonly aiConfig: AiConfigService,
    private readonly chat: OpenAiChatClient,
  ) {}

  async summarize(userId: string, input: SummarizationInput): Promise<SummarizationResult> {
    const config = await this.aiConfig.resolve(userId, 'summarization');
    if (!config) {
      throw new Error(
        'summarization is not configured — add an AI provider and assign it to the ' +
          'summarization capability in Settings → AI',
      );
    }

    const response = await this.chat.chat(config, {
      temperature: 0.3,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt(input) },
      ],
    });
    const parsed = parseSummaryResponse(this.chat.contentOf(response));
    return { ...parsed, model: response.model ?? config.model, raw: response };
  }
}

export const SYSTEM_PROMPT = [
  'You summarize a transcribed audio recording or a typed note for a note-taking app.',
  'Always respond with a single JSON object and nothing else, with keys:',
  '  "title": a short, specific, descriptive title (max ~8 words, no trailing punctuation),',
  '  "layout": one of the layout ids listed by the user,',
  '  "markdown": the summary body as GitHub-flavored Markdown,',
  '  "offTopic": OPTIONAL — off-topic tangents as GitHub-flavored Markdown, or null.',
  '',
  'Off-topic rules:',
  "- Off-topic means digressions, side conversations and tangents unrelated to the recording's main subject — e.g. small talk about the weather or lunch in the middle of a project meeting, or an aside about an unrelated topic.",
  '- Keep "markdown" strictly about the main subject; never mix tangents into it.',
  '- Summarize genuine tangents briefly in "offTopic" (bullet points preferred), attributing speakers the same way as in the main body.',
  '- If the recording stays on topic, set "offTopic" to null or omit it. Never invent or pad tangents to fill this section.',
  '- Write "offTopic" in the same output language as the rest, and follow all Markdown rules below. Do not add an "Off-topic" heading inside it — the app renders its own.',
  '',
  'Markdown rules:',
  '- Write in the output language stated in the user message.',
  '- Do NOT repeat the title as a top-level heading inside the markdown.',
  '- You may use mermaid diagrams inside ```mermaid fenced code blocks when they add clarity (flowchart, sequenceDiagram, mindmap, timeline). Keep them syntactically valid and simple.',
  '- When you refer to a speaker in prose, mention them with the exact token @[LABEL] using their diarization LABEL (e.g. @[SPEAKER_00]); the app turns these into clickable chips. Never invent a LABEL that is not in the roster. Inside mermaid diagrams use the plain display name instead of the token.',
  '- If no speaker roster is provided, just write naturally without mention tokens.',
  '- Be faithful to the transcript; do not invent facts. Prefer concise bullet points over long paragraphs.',
  '- If the user message contains correction notes, they are authoritative: the transcript may contain transcription or scanning errors, and where a note contradicts it, follow the note. Apply corrections silently — never mention the notes or the correction process in the output.',
].join('\n');

/** Build the user message: roster + metadata + the transcript, plus layout menu. */
export function buildUserPrompt(input: SummarizationInput): string {
  const isNote = input.sourceKind === 'note';
  const noun = isNote ? 'note' : 'recording';
  const parts: string[] = [];

  parts.push(
    input.targetLanguage
      ? `Write the title and the entire summary in ${input.targetLanguage}, regardless of the transcript's language.`
      : "Write the title and the entire summary in the transcript's own language.",
    '',
  );

  if (isNote) {
    parts.push(
      'The content below is text content (a typed note, web-page snapshot or email), not an audio transcript — there is no recording and there are no speakers.',
      '',
    );
  }

  parts.push(`Choose the single best layout for this ${noun}:`);
  for (const layout of summaryLayoutSchema.options) {
    parts.push(`- ${layout}: ${LAYOUT_GUIDE[layout]}`);
  }

  const meta: string[] = [];
  if (input.language) meta.push(`language: ${input.language}`);
  if (input.occurredAt) meta.push(`${isNote ? 'written' : 'recorded'} at: ${input.occurredAt}`);
  if (typeof input.durationSeconds === 'number') {
    meta.push(`duration: ${Math.round(input.durationSeconds)}s`);
  }
  if (meta.length > 0) {
    parts.push('', `${isNote ? 'Note' : 'Recording'} metadata — ${meta.join(', ')}.`);
  }

  if (input.speakers.length > 0) {
    const hasOwner = input.speakers.some((s) => s.isSelf);
    parts.push(
      '',
      'Speaker roster (use @[LABEL] to mention a speaker in prose):',
      ...input.speakers.map(
        (s) =>
          `- ${s.label} = ${s.displayName}${s.isSelf ? ' (the note owner / you)' : ''}${
            s.confirmed ? '' : ' (unconfirmed)'
          }`,
      ),
    );
    // When we know who "you" are, phrase the owner's own action items as theirs.
    if (hasOwner) {
      parts.push(
        'One speaker is marked as the note owner ("you"). Attribute action items to',
        'the right speaker; write the owner\'s own action items as theirs ("you").',
      );
    }
  }

  if (input.correctionNotes && input.correctionNotes.length > 0) {
    parts.push(
      '',
      `Correction notes from the user (authoritative — the ${
        isNote ? 'text below' : 'transcript below'
      } may contain ${isNote ? 'errors' : 'transcription errors'}; where a note contradicts it, trust the note and apply the correction throughout, e.g. to misheard names, numbers or words). Never quote or mention these notes in the output:`,
      ...input.correctionNotes.map((note, index) => `${index + 1}. ${note.trim()}`),
    );
  }

  parts.push('', isNote ? 'Note content:' : 'Transcript:', '"""', input.transcript.trim(), '"""');
  return parts.join('\n');
}

/**
 * Parse the model's JSON reply defensively: tolerate code-fence wrapping and an
 * unknown layout (falls back to `general`), but require a usable markdown body.
 */
export function parseSummaryResponse(content: string): {
  title: string;
  layout: SummaryLayout;
  markdown: string;
  offTopic: string | null;
} {
  const json = extractJsonObject(content);
  const rawTitle = typeof json.title === 'string' ? json.title.trim() : '';
  const rawMarkdown = typeof json.markdown === 'string' ? json.markdown.trim() : '';
  const rawOffTopic = typeof json.offTopic === 'string' ? json.offTopic.trim() : '';
  if (!rawMarkdown) {
    throw new Error('summarization response had no markdown body');
  }
  const layoutParse = summaryLayoutSchema.safeParse(json.layout);
  return {
    title: rawTitle || 'Untitled recording',
    layout: layoutParse.success ? layoutParse.data : 'general',
    markdown: rawMarkdown,
    offTopic: rawOffTopic || null,
  };
}

function extractJsonObject(content: string): Record<string, unknown> {
  const trimmed = content.trim();
  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  const candidates = [unfenced, trimmed];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
    } catch {
      /* try the next candidate */
    }
  }
  // Last resort: grab the outermost {...} span.
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try {
      return JSON.parse(trimmed.slice(first, last + 1)) as Record<string, unknown>;
    } catch {
      /* fall through */
    }
  }
  throw new Error('summarization response was not valid JSON');
}
