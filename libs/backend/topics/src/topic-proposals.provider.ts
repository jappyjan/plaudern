/** The evidence handed to the labeler for one cluster: a few sample item texts. */
export interface TopicProposalLabelInput {
  /** Short excerpts from representative cluster members (summary or transcript). */
  samples: string[];
  /** Dominant content language (2-letter code), so the label is in-language. */
  language?: string;
}

export interface TopicProposalLabelResult {
  /** A concise topic/project name for the cluster (e.g. "Hausbau"). */
  label: string;
  /** A one-line description, when the model offers one. */
  description: string | null;
  /** Concrete model that produced the label, for provenance. */
  model?: string;
}

/**
 * Names an embedding cluster (JJ-64). Reuses the same OpenAI-compatible
 * chat-completions backend and TOPICS_* configuration as topic classification
 * (DeepSeek by default), so the feature shares one key/endpoint. Tests override
 * the DI token with a fake.
 */
export interface TopicProposalLabelProvider {
  readonly id: string;
  /** Whether the labeling LLM is configured enough to run (e.g. has an API key). */
  readonly enabled: boolean;
  label(input: TopicProposalLabelInput): Promise<TopicProposalLabelResult>;
}

export const TOPIC_PROPOSAL_LABEL_PROVIDER = Symbol('TOPIC_PROPOSAL_LABEL_PROVIDER');
