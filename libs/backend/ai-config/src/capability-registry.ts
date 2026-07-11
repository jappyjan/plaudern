import type {
  AiCapability,
  AiCapabilityCatalogEntry,
  AiCapabilityKind,
  AiCapabilityParamDescriptor,
  AiProviderProtocol,
} from '@plaudern/contracts';

/**
 * Static, code-owned metadata for every AI capability. This is the single place
 * that knows a capability's shape, its sane defaults, its tunable params and —
 * for the one-time upgrade import — which legacy env vars fed it. It replaces
 * the constellation of `<PREFIX>_{API_KEY,BASE_URL,MODEL,TIMEOUT_MS,ENABLED}`
 * env vars that used to live in `.env.example`.
 *
 * To add a new AI capability: add its id to `aiCapabilitySchema`
 * (`libs/contracts`), add an entry here, and point its provider class at
 * `AiConfigService.resolve(userId, '<capability>')`. Do NOT add an env var.
 */
export interface CapabilityMeta {
  capability: AiCapability;
  label: string;
  description: string;
  kind: AiCapabilityKind;
  compatibleProtocols: AiProviderProtocol[];
  defaultBaseUrl: string | null;
  defaultModel: string | null;
  defaultTimeoutMs: number;
  /** Off unless the user opts in (only `web_research`). */
  optIn: boolean;
  /**
   * When set and this capability has no provider of its own, resolution falls
   * back to the parent capability's provider connection (baseUrl + key) — while
   * still using this capability's own model/params. Reproduces the old in-code
   * env fallbacks (chat→summarization, entity_judge→entity_extraction, …).
   */
  inheritsFrom?: AiCapability;
  defaultParams: Record<string, unknown>;
  params: AiCapabilityParamDescriptor[];
  /**
   * Legacy env prefix this capability was configured under, used ONLY by the
   * one-time boot import. Absent for capabilities that never had their own
   * prefix (they inherit) or that are imported by special-case logic
   * (transcription, speaker_id).
   */
  legacyEnvPrefix?: string;
  /** Legacy env prefix to fall back to when this one is unset (import only). */
  legacyEnvFallbackPrefix?: string;
}

const CHAT_PROTOCOLS: AiProviderProtocol[] = ['openai-compatible'];

/** Params common to nothing — most chat capabilities have no extra knobs. */
const NO_PARAMS: AiCapabilityParamDescriptor[] = [];

const REGISTRY: Record<AiCapability, CapabilityMeta> = {
  summarization: {
    capability: 'summarization',
    label: 'Summarization',
    description: 'Writes each recording/note a title and a Markdown summary.',
    kind: 'chat',
    compatibleProtocols: CHAT_PROTOCOLS,
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    defaultTimeoutMs: 120_000,
    optIn: false,
    defaultParams: {},
    params: NO_PARAMS,
    legacyEnvPrefix: 'SUMMARIZATION',
  },
  embeddings: {
    capability: 'embeddings',
    label: 'Embeddings',
    description: 'Vector embeddings for semantic search and memory chat.',
    kind: 'embeddings',
    compatibleProtocols: CHAT_PROTOCOLS,
    defaultBaseUrl: 'https://api.openai.com/v1',
    defaultModel: 'text-embedding-3-small',
    defaultTimeoutMs: 120_000,
    optIn: false,
    defaultParams: { dimensions: 1536 },
    params: [
      {
        key: 'dimensions',
        label: 'Dimensions',
        type: 'number',
        description:
          'Vector width. Frozen when the embeddings table is first created — changing it later needs a manual migration.',
        placeholder: '1536',
      },
    ],
    legacyEnvPrefix: 'EMBEDDINGS',
  },
  ocr: {
    capability: 'ocr',
    label: 'OCR (vision)',
    description: 'Transcribes text from photos/scans with a vision model.',
    kind: 'vision',
    compatibleProtocols: CHAT_PROTOCOLS,
    defaultBaseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    defaultTimeoutMs: 180_000,
    optIn: false,
    defaultParams: {},
    params: NO_PARAMS,
    legacyEnvPrefix: 'OCR',
  },
  entity_extraction: {
    capability: 'entity_extraction',
    label: 'Entity extraction',
    description: 'Pulls people, orgs, places, … into the knowledge graph.',
    kind: 'chat',
    compatibleProtocols: CHAT_PROTOCOLS,
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    defaultTimeoutMs: 120_000,
    optIn: false,
    defaultParams: {},
    params: NO_PARAMS,
    legacyEnvPrefix: 'ENTITY_EXTRACTION',
  },
  entity_relations: {
    capability: 'entity_relations',
    label: 'Entity relations',
    description: 'Infers relationships between extracted entities.',
    kind: 'chat',
    compatibleProtocols: CHAT_PROTOCOLS,
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    defaultTimeoutMs: 120_000,
    optIn: false,
    inheritsFrom: 'entity_extraction',
    defaultParams: {},
    params: NO_PARAMS,
  },
  entity_judge: {
    capability: 'entity_judge',
    label: 'Duplicate judge',
    description: 'Judges whether two entities are the same real-world thing.',
    kind: 'chat',
    compatibleProtocols: CHAT_PROTOCOLS,
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    defaultTimeoutMs: 60_000,
    optIn: false,
    inheritsFrom: 'entity_extraction',
    defaultParams: {},
    params: NO_PARAMS,
    legacyEnvPrefix: 'ENTITY_JUDGE',
    legacyEnvFallbackPrefix: 'ENTITY_EXTRACTION',
  },
  contact_resolution: {
    capability: 'contact_resolution',
    label: 'Contact resolution',
    description: 'Links extracted people to your address-book contacts.',
    kind: 'chat',
    compatibleProtocols: CHAT_PROTOCOLS,
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    defaultTimeoutMs: 120_000,
    optIn: false,
    inheritsFrom: 'entity_extraction',
    defaultParams: {},
    params: NO_PARAMS,
    legacyEnvPrefix: 'CONTACT_RESOLUTION',
    legacyEnvFallbackPrefix: 'ENTITY_EXTRACTION',
  },
  web_research: {
    capability: 'web_research',
    label: 'Web research',
    description: 'Consults a web-grounded model to disambiguate entities. Opt-in.',
    kind: 'chat',
    compatibleProtocols: CHAT_PROTOCOLS,
    defaultBaseUrl: 'https://api.perplexity.ai',
    defaultModel: 'sonar',
    defaultTimeoutMs: 30_000,
    optIn: true,
    defaultParams: {},
    params: NO_PARAMS,
    legacyEnvPrefix: 'WEB_RESEARCH',
  },
  topics: {
    capability: 'topics',
    label: 'Topics',
    description: 'Classifies and labels recordings into topics.',
    kind: 'chat',
    compatibleProtocols: CHAT_PROTOCOLS,
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    defaultTimeoutMs: 120_000,
    optIn: false,
    defaultParams: {},
    params: NO_PARAMS,
    legacyEnvPrefix: 'TOPICS',
  },
  topic_docs: {
    capability: 'topic_docs',
    label: 'Topic documents',
    description: 'Maintains a living document per topic.',
    kind: 'chat',
    compatibleProtocols: CHAT_PROTOCOLS,
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    defaultTimeoutMs: 120_000,
    optIn: false,
    inheritsFrom: 'summarization',
    defaultParams: {},
    params: NO_PARAMS,
    legacyEnvPrefix: 'TOPIC_DOCS',
    legacyEnvFallbackPrefix: 'SUMMARIZATION',
  },
  journal: {
    capability: 'journal',
    label: 'Auto-journal',
    description: 'Generates day/week/month/year journal entries.',
    kind: 'chat',
    compatibleProtocols: CHAT_PROTOCOLS,
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    defaultTimeoutMs: 120_000,
    optIn: false,
    inheritsFrom: 'summarization',
    defaultParams: {},
    params: NO_PARAMS,
    legacyEnvPrefix: 'JOURNAL',
    legacyEnvFallbackPrefix: 'SUMMARIZATION',
  },
  commitments: {
    capability: 'commitments',
    label: 'Commitments',
    description: 'Extracts promises/commitments made in recordings.',
    kind: 'chat',
    compatibleProtocols: CHAT_PROTOCOLS,
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    defaultTimeoutMs: 120_000,
    optIn: false,
    defaultParams: {},
    params: NO_PARAMS,
    legacyEnvPrefix: 'COMMITMENTS',
  },
  questions: {
    capability: 'questions',
    label: 'Questions',
    description: 'Extracts open questions raised in recordings.',
    kind: 'chat',
    compatibleProtocols: CHAT_PROTOCOLS,
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    defaultTimeoutMs: 120_000,
    optIn: false,
    defaultParams: {},
    params: NO_PARAMS,
    legacyEnvPrefix: 'QUESTIONS',
  },
  tasks: {
    capability: 'tasks',
    label: 'Tasks',
    description: 'Extracts actionable tasks from recordings.',
    kind: 'chat',
    compatibleProtocols: CHAT_PROTOCOLS,
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    defaultTimeoutMs: 120_000,
    optIn: false,
    defaultParams: {},
    params: NO_PARAMS,
    legacyEnvPrefix: 'TASKS',
  },
  decisions: {
    capability: 'decisions',
    label: 'Decisions',
    description: 'Extracts decisions reached in recordings.',
    kind: 'chat',
    compatibleProtocols: CHAT_PROTOCOLS,
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    defaultTimeoutMs: 120_000,
    optIn: false,
    defaultParams: {},
    params: NO_PARAMS,
    legacyEnvPrefix: 'DECISIONS',
  },
  reminders: {
    capability: 'reminders',
    label: 'Reminders',
    description: 'Extracts time-based reminders from recordings.',
    kind: 'chat',
    compatibleProtocols: CHAT_PROTOCOLS,
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    defaultTimeoutMs: 120_000,
    optIn: false,
    defaultParams: {},
    params: NO_PARAMS,
    legacyEnvPrefix: 'REMINDERS',
  },
  facts: {
    capability: 'facts',
    label: 'Personal facts',
    description: 'Extracts durable personal facts about you.',
    kind: 'chat',
    compatibleProtocols: CHAT_PROTOCOLS,
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    defaultTimeoutMs: 120_000,
    optIn: false,
    defaultParams: {},
    params: NO_PARAMS,
    legacyEnvPrefix: 'FACTS',
  },
  docmeta: {
    capability: 'docmeta',
    label: 'Document metadata',
    description: 'Derives metadata for documents in the vault.',
    kind: 'chat',
    compatibleProtocols: CHAT_PROTOCOLS,
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    defaultTimeoutMs: 120_000,
    optIn: false,
    defaultParams: {},
    params: NO_PARAMS,
    legacyEnvPrefix: 'DOCMETA',
  },
  chat: {
    capability: 'chat',
    label: 'Memory chat',
    description: 'Answers questions over your memory (RAG).',
    kind: 'chat',
    compatibleProtocols: CHAT_PROTOCOLS,
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    defaultTimeoutMs: 120_000,
    optIn: false,
    inheritsFrom: 'summarization',
    defaultParams: {},
    params: NO_PARAMS,
    legacyEnvPrefix: 'CHAT',
    legacyEnvFallbackPrefix: 'SUMMARIZATION',
  },
  verification: {
    capability: 'verification',
    label: 'Citation verification',
    description: 'Verifies that answers are grounded in your recordings.',
    kind: 'chat',
    compatibleProtocols: CHAT_PROTOCOLS,
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    defaultTimeoutMs: 120_000,
    optIn: false,
    inheritsFrom: 'summarization',
    defaultParams: {},
    params: NO_PARAMS,
    legacyEnvPrefix: 'VERIFICATION',
    legacyEnvFallbackPrefix: 'SUMMARIZATION',
  },
  transcription: {
    capability: 'transcription',
    label: 'Transcription',
    description: 'Speech-to-text for audio recordings.',
    kind: 'stt',
    compatibleProtocols: ['elevenlabs', 'whisper'],
    defaultBaseUrl: null,
    defaultModel: 'scribe_v2',
    defaultTimeoutMs: 1_800_000,
    optIn: false,
    defaultParams: { tagAudioEvents: false, downloadTimeoutMs: 300_000 },
    params: [
      {
        key: 'tagAudioEvents',
        label: 'Tag audio events',
        type: 'boolean',
        description: 'Tag non-speech sounds like (laughter) inline (ElevenLabs).',
        placeholder: null,
      },
      {
        key: 'downloadTimeoutMs',
        label: 'Audio download timeout (ms)',
        type: 'number',
        description: null,
        placeholder: '300000',
      },
    ],
  },
  speaker_id: {
    capability: 'speaker_id',
    label: 'Speaker diarization',
    description: 'Separates and identifies speakers via voiceprints.',
    kind: 'diarization',
    compatibleProtocols: ['pyannoteai'],
    defaultBaseUrl: 'https://api.pyannote.ai/v1',
    defaultModel: 'precision-2',
    defaultTimeoutMs: 1_800_000,
    optIn: false,
    defaultParams: {
      matchThreshold: 60,
      minEnrollSeconds: 6,
      voiceprintMaxSeconds: 30,
      pollIntervalMs: 3_000,
    },
    params: [
      {
        key: 'matchThreshold',
        label: 'Match threshold (0-100)',
        type: 'number',
        description:
          'Minimum confidence to accept a voiceprint match. Higher is stricter — fewer new voices get wrongly matched to an existing person.',
        placeholder: '60',
      },
      {
        key: 'minEnrollSeconds',
        label: 'Min enroll seconds',
        type: 'number',
        description: 'Minimum speaking time before auto-enrolling a voiceprint.',
        placeholder: '6',
      },
      {
        key: 'voiceprintMaxSeconds',
        label: 'Voiceprint max seconds',
        type: 'number',
        description: 'Max audio used per enrollment voiceprint.',
        placeholder: '30',
      },
      {
        key: 'pollIntervalMs',
        label: 'Poll interval (ms)',
        type: 'number',
        description: null,
        placeholder: '3000',
      },
    ],
  },
};

/** All capability ids in a stable display order. */
export const ALL_CAPABILITIES = Object.keys(REGISTRY) as AiCapability[];

export function capabilityMeta(capability: AiCapability): CapabilityMeta {
  return REGISTRY[capability];
}

/** The full capability catalog for the settings UI. */
export function capabilityCatalog(): AiCapabilityCatalogEntry[] {
  return ALL_CAPABILITIES.map((capability) => {
    const meta = REGISTRY[capability];
    return {
      capability,
      label: meta.label,
      description: meta.description,
      kind: meta.kind,
      compatibleProtocols: meta.compatibleProtocols,
      defaultModel: meta.defaultModel,
      defaultBaseUrl: meta.defaultBaseUrl,
      optIn: meta.optIn,
      params: meta.params,
    };
  });
}

/* ---- Capability groups (the simplified, kind-level settings) ------------- */

/**
 * Static metadata for one capability *group* — the shared, kind-level setting
 * the primary UI exposes. Its defaults (base URL, model, timeout, params) come
 * from the group's *primary* capability; its member list is every capability of
 * that kind, in registry order.
 */
export interface CapabilityGroupMeta {
  kind: AiCapabilityKind;
  label: string;
  description: string;
  /** The capability whose registry defaults seed the group. */
  primary: AiCapability;
  compatibleProtocols: AiProviderProtocol[];
  defaultBaseUrl: string | null;
  defaultModel: string | null;
  defaultTimeoutMs: number;
  params: AiCapabilityParamDescriptor[];
  memberCapabilities: AiCapability[];
}

/** Display order + human labels for the five capability kinds. */
const GROUP_DEFS: Record<
  AiCapabilityKind,
  { label: string; description: string; primary: AiCapability }
> = {
  chat: {
    label: 'Reasoning & Chat',
    description:
      'The text model behind summaries, extraction (tasks, entities, topics, …), journaling and memory chat.',
    primary: 'summarization',
  },
  vision: {
    label: 'Vision & OCR',
    description: 'Reads text from photos and scans with a vision model.',
    primary: 'ocr',
  },
  embeddings: {
    label: 'Embeddings',
    description: 'Vector embeddings that power semantic search and memory chat.',
    primary: 'embeddings',
  },
  stt: {
    label: 'Transcription',
    description: 'Speech-to-text for audio recordings.',
    primary: 'transcription',
  },
  diarization: {
    label: 'Diarization',
    description: 'Separates and identifies speakers via voiceprints.',
    primary: 'speaker_id',
  },
};

/** Group display order. */
export const ALL_CAPABILITY_KINDS = Object.keys(GROUP_DEFS) as AiCapabilityKind[];

/** The kind a capability belongs to. */
export function kindOf(capability: AiCapability): AiCapabilityKind {
  return REGISTRY[capability].kind;
}

/** Members of one kind, in registry display order. */
export function capabilitiesOfKind(kind: AiCapabilityKind): AiCapability[] {
  return ALL_CAPABILITIES.filter((c) => REGISTRY[c].kind === kind);
}

export function capabilityGroupMeta(kind: AiCapabilityKind): CapabilityGroupMeta {
  const def = GROUP_DEFS[kind];
  const members = capabilitiesOfKind(kind);
  const primaryMeta = REGISTRY[def.primary];
  // Protocols any member can speak (deduped, primary's order first).
  const protocols = new Set<AiProviderProtocol>();
  for (const c of members) for (const p of REGISTRY[c].compatibleProtocols) protocols.add(p);
  // Only single-member kinds carry params today; union preserves member order.
  const params = members.flatMap((c) => REGISTRY[c].params);
  return {
    kind,
    label: def.label,
    description: def.description,
    primary: def.primary,
    compatibleProtocols: [...protocols],
    defaultBaseUrl: primaryMeta.defaultBaseUrl,
    defaultModel: primaryMeta.defaultModel,
    defaultTimeoutMs: primaryMeta.defaultTimeoutMs,
    params,
    memberCapabilities: members,
  };
}

/** All five capability groups, in display order. */
export function capabilityGroups(): CapabilityGroupMeta[] {
  return ALL_CAPABILITY_KINDS.map(capabilityGroupMeta);
}
