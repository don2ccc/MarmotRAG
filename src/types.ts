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
  owner: string;
  ownerAvatar?: string;
  content: string;
  chunks: Chunk[];
}

export interface QueryLog {
  id: string;
  timestamp: string;
  query: string;
  pipeline: string;
  answer: string;
  faithfulnessScore: number;
  relevanceScore: number;
  latencyMs: number;
  status: "success" | "warning" | "error";
  retrievedChunks: { text: string; sourceName: string; score: number }[];
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
  // Auth & providers
  ssoEnabled: boolean;
  providerList: { name: string; active: boolean; model: string; status: string }[];
  // Optional external / cloud vector DB (reserved for future integration)
  externalVectorDb: {
    enabled: boolean;
    provider: string;         // e.g. "Pinecone" | "Weaviate" | "Qdrant" | "Milvus" | "Custom"
    apiEndpoint: string;
    apiKey: string;
    indexName: string;
    notes: string;
  };
}

export type TabType = "workspace" | "knowledge-base" | "admin" | "dashboard" | "playground" | "api-access";

/** An API Key issued to an external AI Agent / integration. */
export interface AgentApiKey {
  id: string;
  label: string;             // human-readable name, e.g. "LangChain Bot - Prod"
  key: string;               // the actual secret: "mrmk_<hex>" — shown once on creation
  keyPreview: string;        // masked version: "mrmk_****...****ab12" — always shown
  pipelineId: string | null; // null = caller may choose at query time
  sourceFilter: string[];    // [] = all sources, otherwise restrict retrieval
  rateLimit: number;         // max requests per minute (0 = unlimited)
  enabled: boolean;
  createdAt: string;
  lastUsedAt: string | null;
  usageCount: number;        // total calls served
  usageThisMonth: number;    // calls in current calendar month
}

/** A named RAG pipeline configuration. */
export interface Pipeline {
  id: string;
  name: string;
  description: string;
  generationModel: string;   // e.g. "gemini-3.5-flash" | "gemini-1.5-pro" | "offline"
  topK: number;              // how many chunks to retrieve (1-10)
  minScore: number;          // minimum cosine similarity threshold (0-1)
  systemPrompt: string;      // custom system instruction (empty = use default)
  sourceFilter: string[];    // source doc IDs to restrict retrieval (empty = all)
  enabled: boolean;
  createdAt: string;
}

/** Aggregated live metrics for a Pipeline, computed from QueryLogs. */
export interface PipelineStats {
  pipelineId: string;
  queryCount: number;
  avgLatencyMs: number;
  avgFaithfulness: number;
  avgRelevance: number;
  lastUsed: string | null;
}

/** Live indexing progress attached to a SourceDoc while embedding is running. */
export interface IndexingProgress {
  done: number;
  total: number;
}
