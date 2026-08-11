import { Router } from "express";
import { requireCjs } from "../cjs.js";
import {
  upsertSource, deleteSource, deleteChunksBySource, upsertChunk, loadChunksBySource,
  type PersistedUser,
} from "../db.js";
import { chunkText, retrieveCore } from "../retrieval.js";
import { embedText } from "../embeddings.js";
import { store, recordQueryLog } from "../store.js";
import { denyIfNotOwner } from "../auth.js";
import type { Chunk, QueryLog, SourceDoc } from "../types";

const pdfParse: (buffer: Buffer) => Promise<{ text: string; numpages: number }> = requireCjs("pdf-parse");

function currentUser(req: any): PersistedUser {
  return req.user as PersistedUser;
}

/** Sources the given user may see: own + shared. */
export function visibleSources(userId: string): SourceDoc[] {
  return store.sources.filter(s => s.ownerId === userId || s.isShared);
}

export function createSourcesRouter(): Router {
  const r = Router();

  // List visible sources (own + shared), with optional in-memory pagination/search.
  r.get("/sources", (req, res) => {
    const user = currentUser(req);
    const search = typeof req.query.search === "string" ? req.query.search.trim().toLowerCase() : "";
    const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    let list = visibleSources(user.id);
    if (search) list = list.filter(s => s.name.toLowerCase().includes(search) || s.type.toLowerCase().includes(search));
    const total = list.length;
    const page = list.slice(offset, offset + limit);
    res.json({ sources: page, total, limit, offset });
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

  // Rename/update metadata or share toggle — owner only.
  r.patch("/sources/:id", async (req, res) => {
    const user = currentUser(req);
    const doc = store.sources.find(d => d.id === req.params.id);
    if (!doc) { res.status(404).json({ error: "Source not found" }); return; }
    if (denyIfNotOwner(doc.ownerId, req as any, res)) return;

    const { name, type, status, isShared } = req.body ?? {};
    if (name !== undefined) doc.name = String(name).slice(0, 500).trim();
    if (type !== undefined) doc.type = String(type).slice(0, 200).trim();
    if (status !== undefined && ["Synced", "Paused", "Auth Error"].includes(status)) {
      doc.status = status;
    }
    if (typeof isShared === "boolean") doc.isShared = isShared;

    await upsertSource({
      id: doc.id, name: doc.name, type: doc.type, status: doc.status, lastSync: doc.lastSync,
      vectorsCount: doc.vectorsCount, owner: doc.ownerName, ownerAvatar: "", ownerId: doc.ownerId,
      isShared: doc.isShared, content: doc.content,
    });
    res.json({ id: doc.id, name: doc.name, type: doc.type, status: doc.status, isShared: doc.isShared });
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

  /** Embed all chunks for a doc, streaming SSE progress events. */
  async function embedAndStoreChunks(
    docId: string,
    docName: string,
    rawChunks: string[],
    send: (event: string, data: unknown) => void
  ): Promise<Chunk[]> {
    const chunksData: Chunk[] = [];
    for (let i = 0; i < rawChunks.length; i++) {
      const text = rawChunks[i];
      let embedding: number[];
      try {
        embedding = await embedText(text);
      } catch (err) {
        console.error(`[embed] chunk ${i} failed: ${err}`);
        throw new Error(`Ollama embed failed on chunk ${i}: ${err}`);
      }
      const chunk: Chunk = { id: `${docId}-chk-${i}`, sourceId: docId, sourceName: docName, text, tokensCount: text.split(/\s+/).length, embedding };
      chunksData.push(chunk);
      await upsertChunk(chunk as Required<Chunk>);
      send("progress", { done: i + 1, total: rawChunks.length });
    }
    return chunksData;
  }

  // Add a new document — SSE stream with progress.
  r.post("/sources", async (req, res) => {
    const user = currentUser(req);
    const { name, content, type } = req.body ?? {};
    if (!name || !content) {
      res.status(400).json({ error: "Name and content are required." });
      return;
    }
    const existing = store.sources.find(d => d.name.trim().toLowerCase() === String(name).trim().toLowerCase());
    if (existing) {
      res.status(409).json({ error: `A document named "${name}" already exists. Delete it first or use Re-index to update it.` });
      return;
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    const id = `src-${Date.now()}`;
    const rawChunks = chunkText(
      content,
      store.strategyConfig.chunkSize || 120,
      store.strategyConfig.chunkOverlap || 15,
      store.strategyConfig.separationStrategy || "Semantic"
    );
    const newDoc: SourceDoc = {
      id, name: String(name).slice(0, 500), type: type || "Text Document", status: "Syncing...",
      lastSync: "Just now", vectorsCount: rawChunks.length, ownerId: user.id, ownerName: user.name,
      isShared: false, content, chunks: [],
    };

    await upsertSource({
      id, name: newDoc.name, type: newDoc.type, status: newDoc.status, lastSync: newDoc.lastSync,
      vectorsCount: newDoc.vectorsCount, owner: user.name, ownerAvatar: "", ownerId: user.id,
      isShared: false, content,
    });
    store.sources.unshift(newDoc);
    send("start", { doc: { ...newDoc, chunks: [] }, total: rawChunks.length });

    try {
      const chunksData = await embedAndStoreChunks(id, newDoc.name, rawChunks, send);
      newDoc.chunks = chunksData;
      newDoc.vectorsCount = chunksData.length;
      newDoc.status = "Synced";
      newDoc.lastSync = new Date().toLocaleTimeString("en-US", { hour12: false });
      await upsertSource({
        id, name: newDoc.name, type: newDoc.type, status: "Synced", lastSync: newDoc.lastSync,
        vectorsCount: newDoc.vectorsCount, owner: user.name, ownerAvatar: "", ownerId: user.id,
        isShared: false, content,
      });
      send("done", { doc: { ...newDoc, chunks: [] } });
    } catch (err) {
      newDoc.status = "Auth Error";
      newDoc.vectorsCount = 0;
      await upsertSource({
        id, name: newDoc.name, type: newDoc.type, status: "Auth Error", lastSync: newDoc.lastSync,
        vectorsCount: 0, owner: user.name, ownerAvatar: "", ownerId: user.id, isShared: false, content,
      }).catch(() => {});
      send("error", { message: String(err) });
    }
    res.end();
  });

  // Re-index an existing source — owner only, SSE stream.
  r.post("/sources/:id/reindex", async (req, res) => {
    const user = currentUser(req);
    const doc = store.sources.find(d => d.id === req.params.id);
    if (!doc) { res.status(404).json({ error: "Source not found" }); return; }
    if (denyIfNotOwner(doc.ownerId, req as any, res)) return;

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    doc.status = "Syncing...";
    const rawChunks = chunkText(
      doc.content,
      store.strategyConfig.chunkSize || 120,
      store.strategyConfig.chunkOverlap || 15,
      store.strategyConfig.separationStrategy || "Semantic"
    );
    try { await deleteChunksBySource(req.params.id); } catch (err) {
      console.warn("[reindex] pgvector cleanup failed:", err);
    }
    // Persist the in-flight status so a crash/restart mid-embed can be
    // detected and healed at next startup (see initializeState).
    await upsertSource({
      id: doc.id, name: doc.name, type: doc.type, status: "Syncing...", lastSync: doc.lastSync,
      vectorsCount: doc.vectorsCount, owner: doc.ownerName, ownerAvatar: "", ownerId: doc.ownerId,
      isShared: doc.isShared, content: doc.content,
    });
    send("start", { doc: { ...doc, chunks: [] }, total: rawChunks.length });

    try {
      const chunksData = await embedAndStoreChunks(doc.id, doc.name, rawChunks, send);
      doc.chunks = chunksData;
      doc.vectorsCount = chunksData.length;
      doc.status = "Synced";
      doc.lastSync = new Date().toLocaleTimeString("en-US", { hour12: false });
      await upsertSource({
        id: doc.id, name: doc.name, type: doc.type, status: "Synced", lastSync: doc.lastSync,
        vectorsCount: doc.vectorsCount, owner: doc.ownerName, ownerAvatar: "", ownerId: doc.ownerId,
        isShared: doc.isShared, content: doc.content,
      });
      send("done", { doc: { ...doc, chunks: [] } });
    } catch (err) {
      doc.status = "Auth Error";
      await upsertSource({
        id: doc.id, name: doc.name, type: doc.type, status: "Auth Error", lastSync: doc.lastSync,
        vectorsCount: doc.vectorsCount, owner: doc.ownerName, ownerAvatar: "", ownerId: doc.ownerId,
        isShared: doc.isShared, content: doc.content,
      }).catch(() => {});
      send("error", { message: String(err) });
    }
    res.end();
  });

  // Parse a PDF and return extracted text.
  r.post("/parse-pdf", async (req, res) => {
    const { base64 } = req.body ?? {};
    if (!base64 || typeof base64 !== "string") {
      res.status(400).json({ error: "base64 field is required." });
      return;
    }
    try {
      const buffer = Buffer.from(base64, "base64");
      const data = await pdfParse(buffer);
      const cleanText = data.text.replace(/\x00/g, "").replace(/[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]/g, " ").trim();
      res.json({ text: cleanText, pages: data.numpages });
    } catch (err) {
      console.error("[parse-pdf] Failed to parse PDF:", err);
      res.status(422).json({ error: "Failed to parse PDF. Make sure the file is a valid PDF." });
    }
  });

  // Internal retrieval for the Playground (authenticated by resolveUser).
  r.post("/retrieve", async (req, res) => {
    const user = currentUser(req);
    const { query, topK, minScore, sourceFilter } = req.body ?? {};
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
      });
      const log: QueryLog = {
        id: `log-${Date.now()}`,
        timestamp: new Date().toISOString(),
        query,
        userId: user.id,
        via: "user",
        latencyMs: result.latencyMs,
        status: result.chunks.length > 0 ? "success" : "error",
        retrievedChunks: result.chunks.map(c => ({ chunkId: c.chunkId, sourceName: c.sourceName, text: c.text, score: c.score })),
      };
      recordQueryLog(log);
      res.json(result);
    } catch (err) {
      console.error("[retrieve] failed:", err);
      res.status(500).json({ error: "Embedding failed. Is Ollama running with qwen3-embedding:4b?" });
    }
  });

  return r;
}
