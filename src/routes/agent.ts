import { Router } from "express";
import { upsertAgentKey, deleteAgentKeyById, type PersistedUser } from "../db.js";
import { retrieveCore } from "../retrieval.js";
import { store, recordQueryLog } from "../store.js";
import { createAgentAuth, denyIfNotOwner } from "../auth.js";
import type { AgentApiKey, QueryLog } from "../types";

function currentUser(req: any): PersistedUser {
  return req.user as PersistedUser;
}

/** Cryptographically random API key: 32 bytes → 64 hex chars. */
function generateApiKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
  return `mrmk_${hex}`;
}

/**
 * Mask an API key for display: keep "mrmk_" + first 6 chars + last 4.
 * e.g. mrmk_de3502d979...1f9e → mrmk_de3502****1f9e
 */
export function maskKey(key: string): string {
  return key.length > 14 ? `${key.slice(0, 11)}****${key.slice(-4)}` : key;
}

function toPublic(k: AgentApiKey) {
  const { key: _secret, _monthStamp: _ms, ...pub } = k;
  return pub;
}

export function createAgentRouter(): Router {
  const r = Router();

  const agentAuth = createAgentAuth({
    getKeys: () => store.agentKeys,
    persistKey: async (k) => { await upsertAgentKey({ ...k, monthStamp: k._monthStamp }); },
  });

  // ── Key management (current user manages their own keys) ─────────────
  r.get("/agent/keys", (req, res) => {
    const user = currentUser(req);
    res.json(store.agentKeys.filter(k => k.ownerId === user.id).map(toPublic));
  });

  r.post("/agent/keys", async (req, res) => {
    const user = currentUser(req);
    const { label, sourceFilter, rateLimit } = req.body ?? {};
    const safeLabel = typeof label === "string" ? label.slice(0, 200).trim() : "";
    if (!safeLabel) {
      res.status(400).json({ error: "label is required" });
      return;
    }
    // Only allow source ids the user can actually see.
    const visibleIds = new Set(
      store.sources.filter(s => s.ownerId === user.id || s.isShared).map(s => s.id)
    );
    const allowed = Array.isArray(sourceFilter)
      ? sourceFilter.slice(0, 50).filter((id: unknown) => typeof id === "string" && visibleIds.has(id))
      : [];
    const fullKey = generateApiKey();
    const newKey: AgentApiKey = {
      id: `akey-${Date.now()}`,
      label: safeLabel,
      key: fullKey,
      keyPreview: maskKey(fullKey),
      ownerId: user.id,
      sourceFilter: allowed,
      rateLimit: Math.max(0, Math.min(600, Number(rateLimit) || 60)),
      enabled: true,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      usageCount: 0,
      usageThisMonth: 0,
      _monthStamp: new Date().toISOString().slice(0, 7),
    };
    store.agentKeys.push(newKey);
    await upsertAgentKey({ ...newKey, monthStamp: newKey._monthStamp });
    res.status(201).json({ ...toPublic(newKey), key: fullKey });
  });

  r.patch("/agent/keys/:id", async (req, res) => {
    const user = currentUser(req);
    const key = store.agentKeys.find(k => k.id === req.params.id);
    if (!key || key.ownerId !== user.id) { res.status(404).json({ error: "Key not found" }); return; }
    const { label, sourceFilter, rateLimit, enabled } = req.body ?? {};
    if (label !== undefined) key.label = String(label).slice(0, 200);
    if (Array.isArray(sourceFilter)) key.sourceFilter = sourceFilter.slice(0, 50);
    if (typeof rateLimit === "number") key.rateLimit = Math.max(0, Math.min(600, rateLimit));
    if (typeof enabled === "boolean") key.enabled = enabled;
    await upsertAgentKey({ ...key, monthStamp: key._monthStamp });
    res.json(toPublic(key));
  });

  r.delete("/agent/keys/:id", async (req, res) => {
    const user = currentUser(req);
    const key = store.agentKeys.find(k => k.id === req.params.id);
    if (!key || key.ownerId !== user.id) { res.status(404).json({ error: "Key not found" }); return; }
    store.agentKeys = store.agentKeys.filter(k => k.id !== req.params.id);
    await deleteAgentKeyById(req.params.id);
    res.json({ message: "Key revoked" });
  });

  // ── Agent: retrieve chunks (the core API) ────────────────────────────
  r.post("/agent/retrieve", agentAuth, async (req, res) => {
    const key = (req as any).agentKey as AgentApiKey;
    const { query, topK, minScore, sourceFilter } = req.body ?? {};
    if (!query || typeof query !== "string" || !query.trim()) {
      res.status(400).json({ error: "query (string) is required" });
      return;
    }
    if (query.length > 10000) {
      res.status(400).json({ error: "Query exceeds maximum length of 10,000 characters." });
      return;
    }
    try {
      const result = await retrieveCore({
        query,
        userId: key.ownerId,
        topK: typeof topK === "number" ? topK : undefined,
        minScore: typeof minScore === "number" ? minScore : undefined,
        sourceFilter: Array.isArray(sourceFilter) ? sourceFilter : undefined,
        extraSourceFilter: key.sourceFilter,
      });
      const log: QueryLog = {
        id: `log-${Date.now()}`,
        timestamp: new Date().toISOString(),
        query,
        userId: key.ownerId,
        via: `agent:${key.label}`,
        latencyMs: result.latencyMs,
        status: result.chunks.length > 0 ? "success" : "error",
        retrievedChunks: result.chunks.map(c => ({ chunkId: c.chunkId, sourceName: c.sourceName, text: c.text, score: c.score })),
      };
      recordQueryLog(log);
      res.json(result);
    } catch (err) {
      console.error("[agent/retrieve] failed:", err);
      res.status(500).json({ error: "Embedding failed. Is Ollama running with qwen3-embedding:4b?" });
    }
  });

  return r;
}
