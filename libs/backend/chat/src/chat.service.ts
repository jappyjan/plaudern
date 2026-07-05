import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { runWithAiAudit } from '@plaudern/audit';
import { Repository } from 'typeorm';
import type {
  ChatAskRequest,
  ChatAskResponse,
  ChatCitation,
  ChatConfidence,
  ChatConversationDetailDto,
  ChatConversationDto,
  ChatConversationListResponse,
  ChatMessageDto,
  ChatStatusDto,
  SearchResultItem,
} from '@plaudern/contracts';
import { ChatConversationEntity, ChatMessageEntity } from '@plaudern/persistence';
import { SearchService } from '@plaudern/search';
import { VerificationService } from '@plaudern/citations';
import {
  CHAT_COMPLETION_PROVIDER,
  type ChatCompletionMessage,
  type ChatCompletionProvider,
} from './chat.provider';
import { enforceCitations } from './citation-enforcer';

/** How many prior turns are replayed to the model for conversational context. */
const MAX_HISTORY_MESSAGES = 12;
/** Hybrid-search depth per retrieval query. */
const RETRIEVAL_LIMIT = 8;
/** Cap on numbered sources handed to the model. */
const MAX_SOURCES = 10;
/** Cap on rewritten retrieval queries per question. */
const MAX_QUERIES = 3;
/** Per-passage length cap in the prompt. */
const MAX_PASSAGE_CHARS = 700;

const DISABLED_REASON =
  'memory chat is disabled — set CHAT_API_KEY (or SUMMARIZATION_API_KEY, which it falls ' +
  'back to) for cloud endpoints, or CHAT_ENABLED=true for keyless local endpoints such as Ollama';

/** Said when retrieval finds nothing: no sources → no generation, no guessing. */
const NO_SOURCES_ANSWER =
  "I couldn't find anything about that in your memory. I only answer from what you've " +
  'captured, so I won\'t guess — try rephrasing, or check whether the moment was recorded.';

/** Said when the model produced text but backed none of it with a source. */
const UNCITED_ANSWER =
  "I couldn't back an answer to that with your captured memory, so I won't state it as " +
  'fact. The closest sources I found are attached — check them directly.';

export const ANSWER_SYSTEM_PROMPT = [
  "You answer questions about the user's own captured memory (voice recordings, notes,",
  'emails, web clips) for a memory-prosthesis app. You are given numbered SOURCES —',
  'passages retrieved from that memory.',
  '',
  'Hard rules:',
  '- Answer ONLY from the SOURCES. Never use outside knowledge, and never guess.',
  '- Every factual claim MUST be followed by the citation marker(s) of the source(s)',
  '  that support it, written exactly as [n] using ONLY the numbers provided.',
  '- If the sources do not contain the answer, say you could not find it in the',
  '  captured memory — do not invent one.',
  '- Markers like [n] inside earlier conversation turns refer to EARLIER sources;',
  '  ignore them and cite only from the current SOURCES list.',
  '- Answer in the language the user asked in. Be concise.',
  '',
  'Respond with a single JSON object and nothing else:',
  '  {"answer": "<the answer text with inline [n] markers>",',
  '   "confidence": "high" | "low"}',
  'Use "low" whenever the sources only partially or indirectly support the answer.',
].join('\n');

export const REWRITE_SYSTEM_PROMPT = [
  'You turn the latest question of a conversation into standalone search queries for',
  "retrieval over the user's personal memory archive. Resolve pronouns and references",
  '("he", "that", "the second one") using the conversation. Keep queries short and',
  'keyword-rich; keep the language of the conversation.',
  '',
  'Respond with a single JSON object and nothing else:',
  '  {"queries": ["<standalone query>", ...]}   (1 to 2 queries)',
].join('\n');

/**
 * Memory chat (JJ-37): RAG over everything captured, with structurally
 * enforced citations and audio deep links.
 *
 * Flow per question: (1) optionally rewrite the question into standalone
 * retrieval queries using the conversation history (pronoun resolution),
 * (2) retrieve passages through the SAME hybrid-search pipeline the /search
 * page uses (semantic + keyword + RRF, user-scoped), (3) hand the model ONLY
 * those numbered passages, (4) post-process the answer with
 * {@link enforceCitations}: invalid markers stripped, zero-citation answers
 * replaced by an explicit non-answer, uncited claims downgraded to
 * low confidence ("I think — check the source"). Conversations and the
 * citations behind every answer are persisted, so history replays with its
 * evidence intact.
 */
@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  constructor(
    @Inject(CHAT_COMPLETION_PROVIDER)
    private readonly provider: ChatCompletionProvider,
    private readonly search: SearchService,
    private readonly verification: VerificationService,
    @InjectRepository(ChatConversationEntity)
    private readonly conversations: Repository<ChatConversationEntity>,
    @InjectRepository(ChatMessageEntity)
    private readonly messages: Repository<ChatMessageEntity>,
  ) {}

  status(): ChatStatusDto {
    return this.provider.enabled
      ? { available: true, reason: null }
      : { available: false, reason: DISABLED_REASON };
  }

  async listConversations(userId: string): Promise<ChatConversationListResponse> {
    const rows = await this.conversations.find({
      where: { userId },
      order: { updatedAt: 'DESC' },
      take: 50,
    });
    return { conversations: rows.map(conversationToDto) };
  }

  async getConversation(userId: string, id: string): Promise<ChatConversationDetailDto> {
    const conversation = await this.requireConversation(userId, id);
    const rows = await this.messages.find({
      where: { conversationId: id, userId },
      order: { createdAt: 'ASC' },
    });
    return {
      conversation: conversationToDto(conversation),
      messages: sortStable(rows).map(messageToDto),
    };
  }

  async deleteConversation(userId: string, id: string): Promise<void> {
    const conversation = await this.requireConversation(userId, id);
    // Cascade removes the messages (FK in the migration; explicit on sqlite).
    await this.messages.delete({ conversationId: conversation.id, userId });
    await this.conversations.delete({ id: conversation.id, userId });
  }

  async ask(userId: string, req: ChatAskRequest): Promise<ChatAskResponse> {
    if (!this.provider.enabled) {
      throw new ServiceUnavailableException(DISABLED_REASON);
    }

    const question = req.message.trim();
    const conversation = req.conversationId
      ? await this.requireConversation(userId, req.conversationId)
      : await this.conversations.save(
          this.conversations.create({ userId, title: truncate(question, 80) }),
        );
    if (!conversation.title) {
      conversation.title = truncate(question, 80);
    }

    const history = await this.messages.find({
      where: { conversationId: conversation.id, userId },
      order: { createdAt: 'DESC' },
      take: MAX_HISTORY_MESSAGES,
    });
    history.reverse();

    const userMessage = await this.messages.save(
      this.messages.create({
        conversationId: conversation.id,
        userId,
        role: 'user',
        content: question,
        citations: [],
        confidence: null,
      }),
    );

    // 1. Retrieval — the exact hybrid pipeline the search page uses.
    const queries = await this.buildRetrievalQueries(userId, question, history);
    const sources = await this.retrieve(userId, queries);

    // 2. Generation + structural enforcement.
    let content: string;
    let citations: ChatCitation[];
    let confidence: ChatConfidence | null;
    if (sources.length === 0) {
      // No sources → no generation. An uncited claim is not an answer.
      content = NO_SOURCES_ANSWER;
      citations = [];
      confidence = null;
    } else {
      ({ content, citations, confidence } = await this.answerFromSources(
        userId,
        question,
        history,
        sources,
      ));
    }

    const assistantMessage = await this.messages.save(
      this.messages.create({
        conversationId: conversation.id,
        userId,
        role: 'assistant',
        content,
        citations,
        confidence,
      }),
    );
    // Touch updatedAt (and persist a first title) so the list orders by activity.
    await this.conversations.save(conversation);

    return {
      conversationId: conversation.id,
      userMessage: messageToDto(userMessage),
      assistantMessage: messageToDto(assistantMessage),
    };
  }

  // ---- retrieval ----

  /**
   * The queries to retrieve with. First turn: the question verbatim. Follow-ups
   * additionally ask the model for standalone rewrites ("What did HE say about
   * THAT?" → "doctor dosage instructions"), because the raw follow-up text is
   * often retrieval-hostile. Rewriting is best-effort — any failure falls back
   * to the raw question.
   */
  private async buildRetrievalQueries(
    userId: string,
    question: string,
    history: ChatMessageEntity[],
  ): Promise<string[]> {
    const queries = [question];
    if (history.length === 0) return queries;
    try {
      const transcript = history
        .slice(-6)
        .map((m) => `${m.role}: ${truncate(m.content, 400)}`)
        .join('\n');
      // Attribute the external AI-provider call to this user; chat is not
      // scoped to a single inbox item (JJ-42).
      const { content } = await runWithAiAudit(
        { userId, itemId: null, kind: 'chat' },
        () =>
          this.provider.complete([
            { role: 'system', content: REWRITE_SYSTEM_PROMPT },
            {
              role: 'user',
              content: `Conversation:\n${transcript}\n\nLatest question: ${question}`,
            },
          ]),
      );
      const json = extractJsonObject(content);
      const raw = Array.isArray(json.queries) ? json.queries : [];
      for (const entry of raw) {
        if (typeof entry !== 'string') continue;
        const query = entry.trim().slice(0, 500);
        if (query && !queries.includes(query)) queries.push(query);
        if (queries.length >= MAX_QUERIES) break;
      }
    } catch (cause) {
      this.logger.warn(`query rewrite failed, using the raw question: ${String(cause)}`);
    }
    return queries;
  }

  /** Run each query through hybrid search and merge to the best-ranked items. */
  private async retrieve(userId: string, queries: string[]): Promise<ChatCitation[]> {
    const byItem = new Map<string, { hit: SearchResultItem; score: number }>();
    for (const query of queries) {
      const response = await this.search.search(userId, {
        query: truncate(query, 500),
        limit: RETRIEVAL_LIMIT,
      });
      for (const hit of response.results) {
        const existing = byItem.get(hit.itemId);
        if (!existing || hit.fusedScore > existing.score) {
          byItem.set(hit.itemId, { hit, score: hit.fusedScore });
        }
      }
    }
    return [...byItem.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_SOURCES)
      .map(({ hit }, index) => ({
        marker: index + 1,
        inboxItemId: hit.itemId,
        title: hit.title,
        sourceType: hit.sourceType,
        occurredAt: hit.occurredAt,
        snippet: hit.snippet ? truncate(stripMarks(hit.snippet), MAX_PASSAGE_CHARS) : null,
        startSeconds: hit.startSeconds,
        endSeconds: hit.endSeconds,
      }));
  }

  // ---- generation ----

  private async answerFromSources(
    userId: string,
    question: string,
    history: ChatMessageEntity[],
    sources: ChatCitation[],
  ): Promise<{ content: string; citations: ChatCitation[]; confidence: ChatConfidence }> {
    const messages: ChatCompletionMessage[] = [
      { role: 'system', content: ANSWER_SYSTEM_PROMPT },
      ...history.slice(-MAX_HISTORY_MESSAGES).map(
        (m): ChatCompletionMessage => ({
          role: m.role,
          content: truncate(m.content, 1500),
        }),
      ),
      { role: 'user', content: `${sourcesBlock(sources)}\n\nQuestion: ${question}` },
    ];

    // Attribute the external AI-provider call to this user; chat is not scoped
    // to a single inbox item (JJ-42).
    const { content: raw } = await runWithAiAudit(
      { userId, itemId: null, kind: 'chat' },
      () => this.provider.complete(messages),
    );
    const json = extractJsonObject(raw);
    const answer = typeof json.answer === 'string' && json.answer.trim() ? json.answer : raw;
    const modelConfidence: ChatConfidence = json.confidence === 'low' ? 'low' : 'high';

    const enforced = enforceCitations(answer, new Set(sources.map((s) => s.marker)));

    if (enforced.usedMarkers.length === 0) {
      // Zero valid citations: reject the text outright, surface the nearest
      // sources so the user can check the memory themselves.
      return {
        content: UNCITED_ANSWER,
        citations: sources.slice(0, 3).map((s, index) => ({ ...s, marker: index + 1 })),
        confidence: 'low',
      };
    }

    const bySourceMarker = new Map(sources.map((s) => [s.marker, s]));
    const citations = enforced.usedMarkers.map((orig, index) => ({
      ...(bySourceMarker.get(orig) as ChatCitation),
      marker: index + 1,
    }));

    // Structural confidence: the model's own hedge OR any uncited clause
    // (clause-level coverage, JJ-68) forces low.
    let confidence: ChatConfidence =
      modelConfidence === 'low' || enforced.uncitedClaimCount > 0 ? 'low' : 'high';

    // Verification pass (JJ-20): only worth running when the answer would
    // otherwise ship at HIGH — an LLM-judge re-checks its high-stakes fields
    // (dates/amounts/names) against the cited passages, catching the
    // confident-but-wrong extraction a valid marker can't. Gated + best-effort:
    // disabled or failed verification leaves the structural confidence intact.
    if (confidence === 'high' && this.verification.enabled) {
      const passages = citations
        .map((c) => c.snippet)
        .filter((snippet): snippet is string => !!snippet);
      const outcome = await this.verification.verifyHighStakes(enforced.content, passages);
      if (outcome.ran && outcome.unsupported.length > 0) {
        this.logger.warn(
          `verification flagged unsupported values, downgrading to low: ${outcome.unsupported.join(', ')}`,
        );
        confidence = 'low';
      }
    }

    return { content: enforced.content, citations, confidence };
  }

  // ---- helpers ----

  private async requireConversation(
    userId: string,
    id: string,
  ): Promise<ChatConversationEntity> {
    const conversation = await this.conversations.findOne({ where: { id, userId } });
    if (!conversation) throw new NotFoundException('conversation not found');
    return conversation;
  }
}

function sourcesBlock(sources: ChatCitation[]): string {
  const lines = ['SOURCES:'];
  for (const s of sources) {
    const date = s.occurredAt.slice(0, 10);
    const stamp = s.startSeconds !== null ? ` @${formatSeconds(s.startSeconds)}` : '';
    lines.push(
      `[${s.marker}] ${date} · ${s.sourceType}${stamp} · ${s.title ?? 'Untitled'}`,
      `"""${s.snippet ?? '(no passage text)'}"""`,
    );
  }
  return lines.join('\n');
}

function formatSeconds(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function stripMarks(snippet: string): string {
  return snippet.replace(/<\/?mark>/g, '');
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function conversationToDto(row: ChatConversationEntity): ChatConversationDto {
  return {
    id: row.id,
    title: row.title,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
}

function messageToDto(row: ChatMessageEntity): ChatMessageDto {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    citations: row.citations ?? [],
    confidence: row.confidence,
    createdAt: toIso(row.createdAt),
  };
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/**
 * Same-timestamp tiebreak (sqlite stores second precision): a user question
 * always precedes the assistant answer of its exchange.
 */
function sortStable(rows: ChatMessageEntity[]): ChatMessageEntity[] {
  return rows
    .slice()
    .sort((a, b) => {
      const ta = new Date(a.createdAt).getTime();
      const tb = new Date(b.createdAt).getTime();
      if (ta !== tb) return ta - tb;
      if (a.role === b.role) return 0;
      return a.role === 'user' ? -1 : 1;
    });
}

/** Parse the model's JSON reply defensively (mirrors the topics provider). */
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
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try {
      return JSON.parse(trimmed.slice(first, last + 1)) as Record<string, unknown>;
    } catch {
      /* fall through */
    }
  }
  return {};
}
