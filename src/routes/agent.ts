import { Router } from "express";
import {
  getSourceDetail,
  upsertAgentKey,
  deleteAgentKeyById,
  updateSourceMeta,
  updateCurrentVersionValidity,
  insertFeedback,
  retrievalExists,
  type PersistedUser,
  type SourceDetail,
} from "../db.js";
import { retrieveCore, type RetrievalMode } from "../retrieval.js";
import { ingestText } from "../ingest.js";
import { store, recordQueryLog } from "../store.js";
import { createAgentAuth } from "../auth.js";
import { EMPTY_SCOPE, type AgentApiKey, type KeyScope, type QueryLog } from "../types.js";

/** Max content length for the sync ingest endpoint (memory-sized payloads). */
const AGENT_WRITE_MAX_CONTENT = 50_000;

const ALLOWED_KINDS = new Set(["policy", "process", "contract", "template", "annex", "memory", "document"]);
const ALLOWED_LIFECYCLES = new Set(["effective", "draft", "expired", "revoked"]);
const ALLOWED_VERDICTS = new Set(["grounded", "partial", "unsupported"]);

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
  // `sourceFilter` is a read-only mirror of scope.docIds, kept so the existing
  // dashboard keeps working until the scope builder UI lands.
  return { ...pub, sourceFilter: k.scope.docIds };
}

/** Normalise a scope payload; unknown fields are dropped and arrays trimmed. */
function parseScope(value: unknown): KeyScope {
  if (!value || typeof value !== "object") return { ...EMPTY_SCOPE };
  const raw = value as Record<string, unknown>;
  const strings = (input: unknown): string[] =>
    Array.isArray(input) ? input.filter((v): v is string => typeof v === "string").slice(0, 100) : [];
  return {
    all: raw.all === true,
    collections: strings(raw.collections),
    kinds: strings(raw.kinds),
    tags: strings(raw.tags),
    docIds: strings(raw.docIds),
    allowDraft: raw.allowDraft === true,
    allowExpired: raw.allowExpired === true,
    allowAsOf: raw.allowAsOf === true,
  };
}

/** True when a single document falls inside the key's scope. */
function scopeAllowsDocument(scope: KeyScope, detail: SourceDetail): boolean {
  if (scope.all) return true;
  const okCollection = scope.collections.length === 0
    || (!!detail.collectionId && scope.collections.includes(detail.collectionId));
  const okKind = scope.kinds.length === 0 || scope.kinds.includes(detail.kind);
  const okTags = scope.tags.length === 0 || scope.tags.some(tag => detail.tags.includes(tag));
  const okDoc = scope.docIds.length === 0 || scope.docIds.includes(detail.id);
  return okCollection && okKind && okTags && okDoc;
}

/** ISO timestamp from a date-ish string; throws on an unparseable value. */
function parseDate(value: unknown, field: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${field} must be an ISO date or null.`);
  }
  return date.toISOString();
}

function parseVersion(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number(String(value).replace(/^W\//, "").replace(/"/g, ""));
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}

/** Agent keys may only read documents their scope allows. */
function keyCanSee(key: AgentApiKey, detail: SourceDetail): boolean {
  return scopeAllowsDocument(key.scope, detail);
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
    const { label, scope, sourceFilter, rateLimit } = req.body ?? {};
    const safeLabel = typeof label === "string" ? label.slice(0, 200).trim() : "";
    if (!safeLabel) {
      res.status(400).json({ error: "label is required" });
      return;
    }

    // `scope` is the real contract. `sourceFilter` is the deprecated flat
    // allowlist the old dashboard sends; an empty list there used to mean
    // "everything", so it keeps that meaning for compatibility only.
    const parsedScope: KeyScope = scope !== undefined
      ? parseScope(scope)
      : Array.isArray(sourceFilter)
        ? {
            ...EMPTY_SCOPE,
            all: sourceFilter.length === 0,
            docIds: sourceFilter.filter((id: unknown): id is string => typeof id === "string").slice(0, 100),
          }
        : { ...EMPTY_SCOPE };

    const fullKey = generateApiKey();
    const newKey: AgentApiKey = {
      id: `akey-${Date.now()}`,
      label: safeLabel,
      key: fullKey,
      keyPreview: maskKey(fullKey),
      ownerId: user.id,
      scope: parsedScope,
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
    const { label, scope, sourceFilter, rateLimit, enabled } = req.body ?? {};
    if (label !== undefined) key.label = String(label).slice(0, 200);
    if (scope !== undefined) {
      key.scope = parseScope(scope);
    } else if (Array.isArray(sourceFilter)) {
      key.scope = {
        ...key.scope,
        all: sourceFilter.length === 0,
        docIds: sourceFilter.filter((id: unknown): id is string => typeof id === "string").slice(0, 100),
      };
    }
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

  // ── Agent: read one document (read-modify-write support) ─────────────
  r.get("/agent/sources/:id", agentAuth, async (req, res) => {
    const key = (req as any).agentKey as AgentApiKey;
    try {
      const detail = await getSourceDetail(req.params.id);
      if (!detail || !keyCanSee(key, detail)) {
        res.status(404).json({ error: "Source not found" });
        return;
      }
      res.json(detail);
    } catch (err) {
      console.error("[agent/sources:get] failed:", err);
      res.status(500).json({ error: "Failed to load source." });
    }
  });

  // ── Agent: retrieve chunks (the core API) ────────────────────────────
  r.post("/agent/retrieve", agentAuth, async (req, res) => {
    const key = (req as any).agentKey as AgentApiKey;
    const {
      query, topK, minScore, collections, kinds, tags, docIds,
      asOf, includeExpired, includeDraft, mode, diversity,
    } = req.body ?? {};

    if (!query || typeof query !== "string" || !query.trim()) {
      res.status(400).json({ error: "query (string) is required" });
      return;
    }
    if (query.length > 10000) {
      res.status(400).json({ error: "Query exceeds maximum length of 10,000 characters." });
      return;
    }
    if (typeof asOf === "string" && !key.scope.allowAsOf) {
      res.status(403).json({
        error: "This API key is not allowed to query historical versions (asOf).",
      });
      return;
    }

    const strings = (value: unknown): string[] | undefined =>
      Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : undefined;

    try {
      const result = await retrieveCore({
        query,
        topK: typeof topK === "number" ? topK : undefined,
        minScore: typeof minScore === "number" ? minScore : undefined,
        scope: key.scope,
        collections: strings(collections),
        kinds: strings(kinds),
        tags: strings(tags),
        docIds: strings(docIds),
        asOf: typeof asOf === "string" ? asOf : null,
        includeExpired: includeExpired === true,
        includeDraft: includeDraft === true,
        mode: (["fast", "balanced", "deep"] as RetrievalMode[]).includes(mode) ? mode : undefined,
        diversity: typeof diversity === "number" ? diversity : undefined,
      });

      const log: QueryLog = {
        id: `log-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
        timestamp: new Date().toISOString(),
        query,
        userId: key.ownerId,
        via: `agent:${key.label}`,
        latencyMs: result.latencyMs,
        status: result.status,
        retrievalId: result.retrievalId,
        diagnostics: result.diagnostics,
        retrievedChunks: result.chunks.map(c => ({
          chunkId: c.chunkId,
          citationId: c.citationId,
          sourceName: c.sourceName,
          text: c.text,
          score: c.score,
        })),
      };
      recordQueryLog(log);
      res.json(result);
    } catch (err) {
      console.error("[agent/retrieve] failed:", err);
      const reason = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Retrieval failed: ${reason}` });
    }
  });

  // ── Agent: feedback on a retrieval (closes the quality loop) ─────────
  r.post("/agent/feedback", agentAuth, async (req, res) => {
    const { retrievalId, usedCitationIds, verdict, missingInfo } = req.body ?? {};

    if (typeof retrievalId !== "string" || !retrievalId.trim()) {
      res.status(400).json({ error: "retrievalId (string) is required" });
      return;
    }
    if (typeof verdict !== "string" || !ALLOWED_VERDICTS.has(verdict)) {
      res.status(400).json({ error: `verdict must be one of: ${[...ALLOWED_VERDICTS].join(", ")}` });
      return;
    }

    try {
      if (!(await retrievalExists(retrievalId))) {
        res.status(404).json({ error: "Unknown retrievalId." });
        return;
      }
      await insertFeedback({
        id: `fb-${crypto.randomUUID()}`,
        retrievalId,
        verdict,
        usedCitationIds: Array.isArray(usedCitationIds)
          ? usedCitationIds.filter((id: unknown) => typeof id === "string").slice(0, 50)
          : [],
        missingInfo: typeof missingInfo === "string" ? missingInfo.slice(0, 2000) : null,
        createdAt: new Date().toISOString(),
      });
      res.status(201).json({ ok: true });
    } catch (err) {
      console.error("[agent/feedback] failed:", err);
      res.status(500).json({ error: "Failed to record feedback." });
    }
  });

  // ── Agent: create OR update a source (controlled upsert) ─────────────
  //
  // Create:  no existing id                     → 201, version 1
  // Update:  If-Match / expectedVersion matches → 200, version + 1
  // No match:                                   → 409 with the current version
  //
  // This replaces the old "agents may never overwrite knowledge" rule, which
  // forced append-only knowledge: a price change left both the old and the new
  // value searchable. The optimistic-concurrency check keeps that from becoming
  // a silent overwrite.
  r.post("/agent/sources", agentAuth, async (req, res) => {
    const key = (req as any).agentKey as AgentApiKey;
    const { id, name, type, content, kind, docNo, effectiveFrom, effectiveTo, signedAt, lifecycle } = req.body ?? {};

    if (typeof content !== "string" || !content.trim()) {
      res.status(400).json({ error: "content (string) is required" });
      return;
    }
    const safeContent = content.trim();
    if (safeContent.length > AGENT_WRITE_MAX_CONTENT) {
      res.status(413).json({
        error: `content exceeds maximum length of ${AGENT_WRITE_MAX_CONTENT} characters.`,
      });
      return;
    }

    // Optional caller-supplied id: makes the write idempotent and addressable.
    let sourceId: string;
    if (id !== undefined) {
      if (typeof id !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(id)) {
        res.status(400).json({
          error: "id must be 1-128 characters of letters, digits, '.', '_' or '-'.",
        });
        return;
      }
      sourceId = id;
    } else {
      sourceId = `mem-${crypto.randomUUID()}`;
    }

    let meta: {
      kind?: string;
      docNo?: string | null;
      lifecycle?: string;
      effectiveFrom?: string | null | undefined;
      effectiveTo?: string | null | undefined;
      signedAt?: string | null | undefined;
    };
    try {
      meta = {
        kind: kind === undefined ? undefined : String(kind).trim(),
        docNo: docNo === undefined ? undefined : (docNo === null ? null : String(docNo).trim().slice(0, 200)),
        lifecycle: lifecycle === undefined ? undefined : String(lifecycle).trim(),
        effectiveFrom: parseDate(effectiveFrom, "effectiveFrom"),
        effectiveTo: parseDate(effectiveTo, "effectiveTo"),
        signedAt: parseDate(signedAt, "signedAt"),
      };
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : "Invalid metadata." });
      return;
    }

    if (meta.kind !== undefined && !ALLOWED_KINDS.has(meta.kind)) {
      res.status(400).json({ error: `kind must be one of: ${[...ALLOWED_KINDS].join(", ")}` });
      return;
    }
    if (meta.lifecycle !== undefined && !ALLOWED_LIFECYCLES.has(meta.lifecycle)) {
      res.status(400).json({ error: `lifecycle must be one of: ${[...ALLOWED_LIFECYCLES].join(", ")}` });
      return;
    }
    if (meta.effectiveFrom && meta.effectiveTo && meta.effectiveFrom >= meta.effectiveTo) {
      res.status(400).json({ error: "effectiveTo must be after effectiveFrom." });
      return;
    }

    const ownerName = store.users.find(u => u.id === key.ownerId)?.name ?? key.ownerId;
    const displayName =
      typeof name === "string" && name.trim()
        ? name.trim().slice(0, 500)
        : `Memory ${safeContent.slice(0, 40)}${safeContent.length > 40 ? "…" : ""}`;
    const sourceType =
      typeof type === "string" && type.trim() ? type.trim().slice(0, 200) : "Agent Memory";

    try {
      const existing = await getSourceDetail(sourceId);

      if (!existing) {
        const result = await ingestText({
          id: sourceId,
          name: displayName,
          type: sourceType,
          content: safeContent,
          ownerId: key.ownerId,
          ownerName,
          chunkSize: store.strategyConfig.chunkSize,
          chunkOverlap: store.strategyConfig.chunkOverlap,
          chunkOverlapUnit: store.strategyConfig.chunkOverlapUnit,
          strategy: store.strategyConfig.separationStrategy,
          kind: meta.kind ?? "memory",
          docNo: meta.docNo ?? null,
          lifecycle: meta.lifecycle ?? "effective",
          effectiveFrom: meta.effectiveFrom ?? null,
          effectiveTo: meta.effectiveTo ?? null,
          signedAt: meta.signedAt ?? null,
        });

        res.status(201).json({
          sourceId: result.sourceId,
          name: displayName,
          versionNo: result.versionNo,
          chunkCount: result.chunkCount,
          status: "Synced",
          created: true,
        });
        return;
      }

      if (!keyCanSee(key, existing)) {
        res.status(404).json({ error: "Source not found" });
        return;
      }

      // Optimistic concurrency: never let a stale agent silently overwrite a
      // newer version. The client can retry after reading the current state.
      const expected = parseVersion(req.body?.expectedVersion ?? req.header("if-match"));
      const currentVersion = existing.versionNo ?? 0;
      if (expected === undefined) {
        res.status(409).json({
          error:
            `A source with id "${sourceId}" already exists (version ${currentVersion}). ` +
            `Send expectedVersion (or If-Match) set to ${currentVersion} to update it.`,
          currentVersion,
        });
        return;
      }
      if (expected !== currentVersion) {
        res.status(409).json({
          error: `Version conflict: expected ${expected}, current is ${currentVersion}.`,
          currentVersion,
        });
        return;
      }

      const metadataOnly = existing.contentSha256 !== null
        && existing.content === safeContent;

      if (metadataOnly) {
        // Same content: update metadata/validity in place, no re-embedding.
        await updateSourceMeta(sourceId, {
          name: displayName,
          type: sourceType,
          kind: meta.kind,
          docNo: meta.docNo,
        });
        await updateCurrentVersionValidity(sourceId, {
          lifecycle: meta.lifecycle,
          effectiveFrom: meta.effectiveFrom,
          effectiveTo: meta.effectiveTo,
          signedAt: meta.signedAt,
        });
        res.status(200).json({
          sourceId,
          versionNo: currentVersion,
          chunkCount: existing.chunkCount ?? 0,
          status: existing.status,
          updated: true,
          metadataOnly: true,
        });
        return;
      }

      const result = await ingestText({
        id: sourceId,
        name: displayName,
        type: sourceType,
        content: safeContent,
        ownerId: existing.ownerId,
        ownerName,
        chunkSize: store.strategyConfig.chunkSize,
        chunkOverlap: store.strategyConfig.chunkOverlap,
        chunkOverlapUnit: store.strategyConfig.chunkOverlapUnit,
        strategy: store.strategyConfig.separationStrategy,
        kind: meta.kind ?? existing.kind,
        docNo: meta.docNo === undefined ? existing.docNo : meta.docNo,
        lifecycle: meta.lifecycle ?? "effective",
        effectiveFrom: meta.effectiveFrom ?? null,
        effectiveTo: meta.effectiveTo ?? null,
        signedAt: meta.signedAt ?? null,
        replaceExisting: true,
      });

      res.status(200).json({
        sourceId: result.sourceId,
        name: displayName,
        versionNo: result.versionNo,
        previousVersion: currentVersion,
        chunkCount: result.chunkCount,
        status: "Synced",
        updated: true,
      });
    } catch (err) {
      console.error("[agent/sources] failed:", err);
      const reason = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Ingest failed: ${reason}` });
    }
  });

  return r;
}
