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
  vectorProvider: string;
  apiEndpoint: string;
  environment: string[];
  ssoEnabled: boolean;
  providerList: { name: string; active: boolean; model: string; status: string }[];
}

export type TabType = "workspace" | "knowledge-base" | "admin" | "dashboard" | "playground";
