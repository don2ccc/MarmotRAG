import type { AgentApiKey, QueryLog, SourceDoc, StrategyConfig } from "./types";
import { insertQueryLog, type PersistedUser } from "./db";

/**
 * In-memory runtime state, loaded/seeded from Postgres at startup.
 * Routers mutate these arrays directly; db.ts persists every change.
 */
export const store = {
  sources: [] as SourceDoc[],
  users: [] as PersistedUser[],
  agentKeys: [] as AgentApiKey[],
  queryLogs: [] as QueryLog[],
  strategyConfig: {} as StrategyConfig,
};

/** Append a retrieval log in memory and persist asynchronously (best effort). */
export function recordQueryLog(log: QueryLog): void {
  store.queryLogs.unshift(log);
  insertQueryLog(log).catch(err => console.warn("[query-log] DB insert failed:", err));
}
