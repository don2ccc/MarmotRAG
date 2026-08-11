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
  status: "success" | "error";
  retrievedChunks: { chunkId: string; sourceName: string; text: string; score: number }[];
}

export interface StrategyConfig {
  chunkSize: number;
  chunkOverlap: number;
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
 * Safe public representation of an Agent API Key — no secret, no internal fields.
 */
export interface AgentApiKeyPublic {
  id: string;
  label: string;
  keyPreview: string;
  sourceFilter: string[];    // [] = all visible sources, otherwise restrict retrieval
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
export interface RetrieveResult {
  query: string;
  chunks: {
    chunkId: string;
    sourceId: string;
    sourceName: string;
    text: string;
    score: number;
    tokenCount: number;
  }[];
  context: string;
  latencyMs: number;
}
