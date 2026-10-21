export interface Chunk {
  id: string;
  sourceId: string;
  sourceName: string;
  text: string;
  tokensCount: number;
  embedding?: number[];
}

export interface SourceDoc {
  id: string;
  name: string;
  type: string;
  status: "Synced" | "Syncing..." | "Paused" | "Auth Error";
  lastSync: string;
  vectorsCount: number;
  ownerId: string;
  ownerName: string;
  isShared: boolean;
  content: string;
  chunks: Chunk[];
  /** Collection the document belongs to (one per document). */
  collectionId?: string | null;
  collectionName?: string | null;
  tags?: string[];
  meta?: Record<string, unknown>;
  /** policy | process | contract | template | annex | memory | document */
  kind?: string;
  docNo?: string | null;
  /** Current version number and its editorial validity (read-only projection). */
  versionNo?: number | null;
  lifecycle?: string | null;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
  /** Reason the last indexing attempt failed, when the document has no version. */
  lastError?: string | null;
}

/** Query log — retrieval only (no answer, no scores). */
export interface QueryLog {
  id: string;
  /** ISO 8601 full datetime string, e.g. "2025-01-15T14:22:18.000Z" */
  timestamp: string;
  query: string;
  /** Owner of the log entry (dashboard user or agent key owner). */
  userId: string;
  /** "user" for playground queries, "agent:<label>" for API key calls. */
  via: string;
  latencyMs: number;
  /** hit = usable, weak = low confidence, empty = nothing found, error = failed. */
  status: "success" | "error" | "hit" | "weak" | "empty";
  /** Stable id handed back to the caller; feedback references it. */
  retrievalId?: string | null;
  diagnostics?: unknown;
  retrievedChunks: { chunkId: string; citationId?: string; sourceName: string; text: string; score: number }[];
}

export interface StrategyConfig {
  chunkSize: number;
  /** Percentage of chunkSize (0-50). Legacy configs used a token count. */
  chunkOverlap: number;
  /** "percent" (current) or "tokens" (legacy, migrated on load). */
  chunkOverlapUnit?: "percent" | "tokens";
  separationStrategy: string;
  // Local pgvector store
  pgHost: string;
  pgPort: string;
  pgDatabase: string;
  pgTable: string;
  // Ollama embedding
  embeddingProvider: string;
  embeddingModel: string;
  embeddingDimension: number;
  ollamaBaseUrl: string;
}

export type TabType = "workspace" | "knowledge-base" | "admin" | "dashboard" | "playground" | "api-access";

/**
 * What an API key is allowed to read.
 *
 * Dimensions are ANDed with "empty = no restriction"; when every dimension is
 * empty and `all` is false the key can read nothing (deny by default).
 */
export interface KeyScope {
  all: boolean;
  collections: string[];
  kinds: string[];
  tags: string[];
  docIds: string[];
  /** Include versions whose lifecycle is `draft`. */
  allowDraft: boolean;
  /** Include documents past `effective_to`. */
  allowExpired: boolean;
  /** Allow `asOf` historical retrieval. */
  allowAsOf: boolean;
}

export const EMPTY_SCOPE: KeyScope = {
  all: false,
  collections: [],
  kinds: [],
  tags: [],
  docIds: [],
  allowDraft: false,
  allowExpired: false,
  allowAsOf: false,
};

export interface Collection {
  id: string;
  name: string;
  description: string;
  defaultKind: string;
  documentCount: number;
  createdAt: string;
}

/**
 * Safe public representation of an Agent API Key — no secret, no internal fields.
 */
export interface AgentApiKeyPublic {
  id: string;
  label: string;
  keyPreview: string;
  scope: KeyScope;
  rateLimit: number;         // max requests per minute (0 = unlimited)
  enabled: boolean;
  createdAt: string;
  lastUsedAt: string | null;
  usageCount: number;
  usageThisMonth: number;
}

/** Response returned ONCE when a new key is created — full plaintext secret. */
export interface AgentApiKeyCreated extends AgentApiKeyPublic {
  key: string;
}

/** Full server-side record including internal tracking fields. */
export interface AgentApiKey extends AgentApiKeyPublic {
  ownerId: string;           // owning user id
  key: string;
  _monthStamp: string;       // "YYYY-MM" for monthly usage reset — internal only
}

/** Live indexing progress attached to a SourceDoc while embedding is running. */
export interface IndexingProgress {
  done: number;
  total: number;
}

/** Demo user shown in the switcher (mirrors marmot_users rows). */
export interface UserInfo {
  id: string;
  name: string;
  email: string;
  role: string;
  lastLogin: string;
}

/** GET /api/health response. */
export interface HealthStatus {
  status: string;
  pgConnected: boolean;
  ollamaConnected: boolean;
  pgHost: string;
  pgDatabase: string;
  ollamaBaseUrl: string;
}

/** GET /api/stats response. */
export interface SystemStats {
  totalVectors: number;
  activeSourceCount: number;
  syncedSourceCount: number;
  ownSources: number;
  queryCount: number;
  avgLatencyMs: number;
}

/** POST /api/retrieve or /api/agent/retrieve response. */
export interface Citation {
  citationId: string;
  chunkId: string;
  docId: string;
  docNo: string | null;
  kind: string;
  title: string;
  versionNo: number;
  clauseNo: string | null;
  clausePath: string | null;
  page: number | null;
  charRange: [number, number] | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  lifecycle: string;
  score: number;
}

export interface RetrievalDiagnostics {
  vectorHits: number;
  lexicalHits: number;
  fused: number;
  returned: number;
  deduped: number;
  bestScore: number;
  scoreGap: number;
  degraded: boolean;
  reranked: boolean;
  lexicalKeys: string[];
  tookMs: number;
}

export interface RetrieveResult {
  query: string;
  retrievalId: string;
  status: "hit" | "weak" | "empty";
  citations: Citation[];
  chunks: {
    citationId: string;
    chunkId: string;
    sourceId: string;
    sourceName: string;
    text: string;
    score: number;
    tokenCount: number;
    versionNo: number;
    clauseNo: string | null;
    clausePath: string | null;
  }[];
  context: string;
  diagnostics: RetrievalDiagnostics;
  latencyMs: number;
}
