import { Router } from "express";
import { requireCjs } from "../cjs.js";
import {
  upsertSource, deleteSource, deleteChunksBySource, loadChunksBySource,
  renameChunksSourceName, isVersionBuilding, loadVersionStates,
  updateSourceMeta, updateCurrentVersionValidity, getSourceDetail,
  type PersistedUser,
} from "../db.js";
import { retrieveCore } from "../retrieval.js";
import { indexSource, planChunks, policyFromConfig, rebuildMissingVersions } from "../indexing.js";
import { store, recordQueryLog } from "../store.js";
import { denyIfNotOwner } from "../auth.js";
import type { QueryLog, SourceDoc } from "../types";

const pdfParse: (buffer: Buffer) => Promise<{ text: string; numpages: number }> = requireCjs("pdf-parse");
const mammoth = requireCjs("mammoth") as {
  extractRawText(input: { buffer: Buffer }): Promise<{ value: string; messages: unknown[] }>;
};
const iconv = requireCjs("iconv-lite") as {
  decode(buffer: Buffer, encoding: string): string;
};

function currentUser(req: any): PersistedUser {
  return req.user as PersistedUser;
}

/** Decode a text file: UTF-8 (with BOM handling), UTF-16, then GBK fallback. */
function decodeTextBuffer(buffer: Buffer): string {
  // UTF-8 BOM
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.subarray(3).toString("utf8");
  }
  // UTF-16 LE / BE BOM
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString("utf16le");
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return iconv.decode(buffer.subarray(2), "utf16-be");
  }
  // Strict UTF-8; Node replaces invalid sequences with U+FFFD, so fall back to
  // GBK for ANSI/Chinese-encoded txt files.
  const utf8 = buffer.toString("utf8");
  if (!utf8.includes("\uFFFD")) return utf8;
  return iconv.decode(buffer, "gbk");
}

function sanitizeText(text: string): string {
  return text.replace(/\x00/g, "").replace(/[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]/g, " ").trim();
}

const ALLOWED_KINDS = new Set(["policy", "process", "contract", "template", "annex", "memory", "document"]);
const ALLOWED_LIFECYCLES = new Set(["effective", "draft", "expired", "revoked"]);

function parseDate(value: unknown, field: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) throw new Error(`${field} must be an ISO date or null.`);
  return date.toISOString();
}

/** Sources the given user may see: own + shared. */
export function visibleSources(userId: string): SourceDoc[] {
  return store.sources.filter(s => s.ownerId === userId || s.isShared);
}

export function createSourcesRouter(): Router {
  const r = Router();

  // List visible sources (own + shared), with optional in-memory pagination/search.
  // Version/validity fields are projected from the DB (the in-memory cache only
  // holds document metadata).
  r.get("/sources", async (req, res) => {
    const user = currentUser(req);
    const search = typeof req.query.search === "string" ? req.query.search.trim().toLowerCase() : "";
    const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    let list = visibleSources(user.id);
    if (search) list = list.filter(s => s.name.toLowerCase().includes(search) || s.type.toLowerCase().includes(search));
    const total = list.length;
    const page = list.slice(offset, offset + limit);

    let versionById = new Map<string, Awaited<ReturnType<typeof loadVersionStates>>[number]>();
    try {
      versionById = new Map((await loadVersionStates()).map(s => [s.id, s]));
    } catch (err) {
      console.warn("[sources] version projection failed:", err);
    }
    const enriched = page.map(doc => {
      const state = versionById.get(doc.id);
      return state
        ? {
            ...doc,
            kind: state.kind,
            docNo: state.docNo,
            versionNo: state.versionNo,
            lifecycle: state.lifecycle,
            effectiveFrom: state.effectiveFrom,
            effectiveTo: state.effectiveTo,
            lastError: state.lastError,
          }
        : doc;
    });
    res.json({ sources: enriched, total, limit, offset });
  });

  // Chunk preview for a visible source.
  r.get("/sources/:id/chunks", async (req, res) => {
    const user = currentUser(req);
    const doc = store.sources.find(d => d.id === req.params.id);
    if (!doc || !(doc.ownerId === user.id || doc.isShared)) {
      res.status(404).json({ error: "Source not found" });
      return;
    }
    const limit = Math.max(1, Math.min(50, Number(req.query.limit) || 10));
    const chunks = await loadChunksBySource(req.params.id, limit);
    res.json({ sourceId: doc.id, sourceName: doc.name, chunks });
  });

  // Rename/update metadata, validity or share toggle — owner only.
  r.patch("/sources/:id", async (req, res) => {
    const user = currentUser(req);
    const doc = store.sources.find(d => d.id === req.params.id);
    if (!doc) { res.status(404).json({ error: "Source not found" }); return; }
    if (denyIfNotOwner(doc.ownerId, req as any, res)) return;

    const {
      name, type, status, isShared, kind, docNo,
      lifecycle, effectiveFrom, effectiveTo, signedAt,
    } = req.body ?? {};

    let dates: {
      effectiveFrom?: string | null;
      effectiveTo?: string | null;
      signedAt?: string | null;
    };
    try {
      dates = {
        effectiveFrom: parseDate(effectiveFrom, "effectiveFrom"),
        effectiveTo: parseDate(effectiveTo, "effectiveTo"),
        signedAt: parseDate(signedAt, "signedAt"),
      };
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : "Invalid date." });
      return;
    }

    if (kind !== undefined && !ALLOWED_KINDS.has(String(kind))) {
      res.status(400).json({ error: `kind must be one of: ${[...ALLOWED_KINDS].join(", ")}` });
      return;
    }
    if (lifecycle !== undefined && !ALLOWED_LIFECYCLES.has(String(lifecycle))) {
      res.status(400).json({ error: `lifecycle must be one of: ${[...ALLOWED_LIFECYCLES].join(", ")}` });
      return;
    }

    if (name !== undefined) doc.name = String(name).slice(0, 500).trim();
    if (type !== undefined) doc.type = String(type).slice(0, 200).trim();
    if (status !== undefined && ["Synced", "Paused", "Auth Error"].includes(status)) {
      doc.status = status;
    }
    if (typeof isShared === "boolean") doc.isShared = isShared;
    if (kind !== undefined) doc.kind = String(kind);
    if (docNo !== undefined) doc.docNo = docNo === null ? null : String(docNo).slice(0, 200);

    await upsertSource({
      id: doc.id, name: doc.name, type: doc.type, status: doc.status, lastSync: doc.lastSync,
      vectorsCount: doc.vectorsCount, owner: doc.ownerName, ownerAvatar: "", ownerId: doc.ownerId,
      isShared: doc.isShared, content: doc.content,
    });
    // Document-level metadata lives on the document row; validity lives on the
    // version currently being served.
    await updateSourceMeta(doc.id, { kind: doc.kind, docNo: doc.docNo });
    await updateCurrentVersionValidity(doc.id, { lifecycle, ...dates });
    // source_name is denormalized onto chunks; keep search results in sync.
    await renameChunksSourceName(doc.id, doc.name);

    const detail = await getSourceDetail(doc.id).catch(() => null);
    res.json({
      id: doc.id,
      name: doc.name,
      type: doc.type,
      status: doc.status,
      isShared: doc.isShared,
      kind: detail?.kind ?? doc.kind,
      docNo: detail?.docNo ?? doc.docNo ?? null,
      versionNo: detail?.versionNo ?? null,
      lifecycle: detail?.lifecycle ?? null,
      effectiveFrom: detail?.effectiveFrom ?? null,
      effectiveTo: detail?.effectiveTo ?? null,
    });
  });

  // Repair: rebuild every owned document that has no servable version.
  // Runs in the background, sequentially — a local embedding server handles one
  // request at a time, and parallel rebuilds are what caused the timeouts.
  r.post("/sources/rebuild-missing", async (req, res) => {
    const user = currentUser(req);
    const ids = store.sources.filter(s => s.ownerId === user.id).map(s => s.id);
    void rebuildMissingVersions({ docIds: ids })
      .then(result => {
        if (result.total > 0) {
          console.log(`[rebuild-missing] rebuilt ${result.rebuilt}/${result.total}, failed ${result.failed}`);
        }
      })
      .catch(err => console.error("[rebuild-missing] failed:", err));
    res.status(202).json({
      message: "Rebuild started for documents without a servable version.",
      documents: ids.length,
    });
  });

  // Delete a source and its chunks — owner only.
  r.delete("/sources/:id", async (req, res) => {
    const user = currentUser(req);
    const doc = store.sources.find(d => d.id === req.params.id);
    if (!doc) { res.status(404).json({ error: "Source not found" }); return; }
    if (denyIfNotOwner(doc.ownerId, req as any, res)) return;
    store.sources = store.sources.filter(d => d.id !== req.params.id);
    try {
      await deleteChunksBySource(req.params.id);
      await deleteSource(req.params.id);
    } catch (err) {
      console.warn("[delete-source] cleanup failed:", err);
    }
    res.json({ message: "Source deleted" });
  });

  // Add a new document — SSE stream with progress.
  r.post("/sources", async (req, res) => {
    const user = currentUser(req);
    const { name, content, type, kind, docNo } = req.body ?? {};
    if (!name || !content) {
      res.status(400).json({ error: "Name and content are required." });
      return;
    }
    if (kind !== undefined && !ALLOWED_KINDS.has(String(kind))) {
      res.status(400).json({ error: `kind must be one of: ${[...ALLOWED_KINDS].join(", ")}` });
      return;
    }
    const existing = store.sources.find(d => d.name.trim().toLowerCase() === String(name).trim().toLowerCase());
    if (existing) {
      res.status(409).json({ error: `A document named "${name}" already exists. Delete it first or use Re-index to update it.` });
      return;
    }

    const policy = policyFromConfig(store.strategyConfig);
    const planned = planChunks(content, policy);
    if (planned.length === 0) {
      res.status(422).json({ error: "The document produced no chunks." });
      return;
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    const id = `src-${Date.now()}`;
    const newDoc: SourceDoc = {
      id, name: String(name).slice(0, 500), type: type || "Text Document", status: "Syncing...",
      lastSync: "", vectorsCount: 0, ownerId: user.id, ownerName: user.name,
      isShared: false, content, chunks: [],
      kind: kind ?? "document",
      docNo: docNo === undefined || docNo === null ? null : String(docNo).slice(0, 200),
    };

    // The row has to exist before the shadow build starts: beginVersion() reads
    // and claims it. status stays "Syncing..." because there is nothing to serve.
    await upsertSource({
      id, name: newDoc.name, type: newDoc.type, status: "Syncing...", lastSync: "",
      vectorsCount: 0, owner: user.name, ownerAvatar: "", ownerId: user.id,
      isShared: false, content,
    });
    await updateSourceMeta(id, { kind: newDoc.kind, docNo: newDoc.docNo ?? null });
    store.sources.unshift(newDoc);
    send("start", { doc: { ...newDoc, chunks: [] }, total: planned.length });

    try {
      const result = await indexSource({
        sourceId: id,
        sourceName: newDoc.name,
        content,
        chunkSize: policy.chunkSize,
        chunkOverlapPercent: policy.chunkOverlapPercent,
        strategy: policy.strategy,
        onProgress: (done, total) => send("progress", { done, total }),
      });
      newDoc.status = "Synced";
      newDoc.vectorsCount = result.chunkCount;
      newDoc.lastSync = result.lastSync;
      send("done", { doc: { ...newDoc, chunks: [] } });
    } catch (err) {
      // abortVersion() already dropped the partial version and, because this
      // document never had an active version, switched the DB status to "Auth Error".
      newDoc.status = "Auth Error";
      newDoc.vectorsCount = 0;
      console.error("[sources/create] indexing failed:", err);
      send("error", { message: String(err), status: "Auth Error" });
    }
    res.end();
  });

  // Re-index an existing source — owner only, SSE stream.
  //
  // The chunks that are currently served stay untouched until the new build
  // commits, so retrieval keeps answering from the old snapshot for the whole
  // rebuild, and a failure records an error without removing knowledge.
  r.post("/sources/:id/reindex", async (req, res) => {
    const user = currentUser(req);
    const doc = store.sources.find(d => d.id === req.params.id);
    if (!doc) { res.status(404).json({ error: "Source not found" }); return; }
    if (denyIfNotOwner(doc.ownerId, req as any, res)) return;

    if (await isVersionBuilding(doc.id)) {
      res.status(409).json({ error: "A re-index is already running for this document." });
      return;
    }

    const policy = policyFromConfig(store.strategyConfig);
    const planned = planChunks(doc.content, policy);
    if (planned.length === 0) {
      res.status(422).json({ error: "This document has no content to index." });
      return;
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    // A re-index must not silently reset editorial validity: the new version
    // inherits the dates/lifecycle of the version it replaces.
    const current = await getSourceDetail(doc.id).catch(() => null);

    send("start", { doc: { ...doc, chunks: [] }, total: planned.length });

    try {
      const result = await indexSource({
        sourceId: doc.id,
        sourceName: doc.name,
        content: doc.content,
        chunkSize: policy.chunkSize,
        chunkOverlapPercent: policy.chunkOverlapPercent,
        strategy: policy.strategy,
        lifecycle: current?.lifecycle ?? undefined,
        effectiveFrom: current?.effectiveFrom ?? null,
        effectiveTo: current?.effectiveTo ?? null,
        signedAt: current?.signedAt ?? null,
        onProgress: (done, total) => send("progress", { done, total }),
      });
      doc.status = "Synced";
      doc.vectorsCount = result.chunkCount;
      doc.lastSync = result.lastSync;
      doc.versionNo = result.versionNo;
      send("done", { doc: { ...doc, chunks: [] } });
    } catch (err) {
      // The previous build is still active, so the source stays searchable.
      doc.status = "Synced";
      console.error("[sources/reindex] build failed, previous build kept:", err);
      send("error", { message: String(err), status: "Synced" });
    }
    res.end();
  });

  // Parse an uploaded document (PDF / TXT / DOCX) and return extracted text.
  r.post("/parse-document", async (req, res) => {
    const { base64, filename } = req.body ?? {};
    if (!base64 || typeof base64 !== "string") {
      res.status(400).json({ error: "base64 field is required." });
      return;
    }
    const name = typeof filename === "string" && filename.trim() ? filename.trim() : "";
    if (!name) {
      res.status(400).json({ error: "filename field is required." });
      return;
    }
    const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";

    try {
      const buffer = Buffer.from(base64, "base64");
      switch (ext) {
        case "pdf": {
          const data = await pdfParse(buffer);
          const text = sanitizeText(data.text);
          if (!text) { res.status(422).json({ error: "No extractable text found in the PDF." }); return; }
          res.json({ text, pages: data.numpages, format: "pdf" });
          return;
        }
        case "txt":
        case "text":
        case "md":
        case "markdown": {
          const text = sanitizeText(decodeTextBuffer(buffer));
          if (!text) { res.status(422).json({ error: "The text file is empty." }); return; }
          res.json({ text, format: "text" });
          return;
        }
        case "docx": {
          const { value } = await mammoth.extractRawText({ buffer });
          const text = sanitizeText(value);
          if (!text) { res.status(422).json({ error: "No extractable text found in the DOCX." }); return; }
          res.json({ text, format: "docx" });
          return;
        }
        case "doc":
          res.status(415).json({ error: "Legacy .doc files are not supported. Please save the file as .docx or paste the text." });
          return;
        default:
          res.status(415).json({ error: "Unsupported file type. Supported formats: .pdf, .txt, .docx." });
          return;
      }
    } catch (err) {
      console.error("[parse-document] Failed to parse document:", err);
      res.status(422).json({ error: "Failed to parse the document. Make sure it is a valid file." });
    }
  });

  // Internal retrieval for the Playground (authenticated by resolveUser).
  r.post("/retrieve", async (req, res) => {
    const user = currentUser(req);
    const {
      query, topK, minScore, sourceFilter, kinds, docIds, asOf, includeExpired, mode, diversity,
    } = req.body ?? {};
    if (!query || typeof query !== "string" || !query.trim()) {
      res.status(400).json({ error: "Query is required" });
      return;
    }
    if (query.length > 10000) {
      res.status(400).json({ error: "Query exceeds maximum length of 10,000 characters." });
      return;
    }
    try {
      const result = await retrieveCore({
        query,
        userId: user.id,
        topK: typeof topK === "number" ? topK : undefined,
        minScore: typeof minScore === "number" ? minScore : undefined,
        sourceFilter: Array.isArray(sourceFilter) ? sourceFilter : undefined,
        kinds: Array.isArray(kinds) ? kinds.filter((k: unknown) => typeof k === "string") : undefined,
        docIds: Array.isArray(docIds) ? docIds.filter((d: unknown) => typeof d === "string") : undefined,
        asOf: typeof asOf === "string" ? asOf : null,
        includeExpired: includeExpired === true,
        mode: (["fast", "balanced", "deep"] as const).includes(mode) ? mode : undefined,
        diversity: typeof diversity === "number" ? diversity : undefined,
      });
      const log: QueryLog = {
        id: `log-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
        timestamp: new Date().toISOString(),
        query,
        userId: user.id,
        via: "user",
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
      console.error("[retrieve] failed:", err);
      const reason = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Retrieval failed: ${reason}` });
    }
  });

  return r;
}
