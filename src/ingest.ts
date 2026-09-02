import { chunkText } from "./retrieval.js";
import { embedText } from "./embeddings.js";
import { upsertChunk, upsertSource, deleteChunksBySource, deleteSource } from "./db.js";
import { store } from "./store.js";
import type { Chunk, SourceDoc } from "./types.js";

export interface IngestResult {
  sourceId: string;
  name: string;
  chunkCount: number;
}

export interface IngestOptions {
  id: string;
  name: string;
  type: string;
  content: string;
  ownerId: string;
  ownerName: string;
  chunkSize: number;
  chunkOverlap: number;
  strategy: string;
}

/**
 * Chunk → embed → persist a new source (create-only).
 *
 * Used by the Agent write API. The caller is never allowed to update an
 * existing source through this path; management (rename/share/reindex/
 * delete) stays in the dashboard. On any embedding failure the partially
 * created source and chunks are removed, so a retry with the same id works.
 */
export async function ingestText(opts: IngestOptions): Promise<IngestResult> {
  const rawChunks = chunkText(opts.content, opts.chunkSize, opts.chunkOverlap, opts.strategy);
  if (rawChunks.length === 0) {
    throw new Error("content produced no chunks");
  }

  const doc: SourceDoc = {
    id: opts.id,
    name: opts.name,
    type: opts.type,
    status: "Syncing...",
    lastSync: "Just now",
    vectorsCount: rawChunks.length,
    ownerId: opts.ownerId,
    ownerName: opts.ownerName,
    isShared: false,
    content: opts.content,
    chunks: [],
  };

  await upsertSource({
    id: doc.id, name: doc.name, type: doc.type, status: doc.status, lastSync: doc.lastSync,
    vectorsCount: doc.vectorsCount, owner: doc.ownerName, ownerAvatar: "", ownerId: doc.ownerId,
    isShared: false, content: doc.content,
  });
  store.sources.unshift(doc);

  try {
    const chunksData: Chunk[] = [];
    for (let i = 0; i < rawChunks.length; i++) {
      const text = rawChunks[i];
      const embedding = await embedText(text);
      const chunk: Chunk = {
        id: `${doc.id}-chk-${i}`,
        sourceId: doc.id,
        sourceName: doc.name,
        text,
        tokensCount: text.split(/\s+/).length,
        embedding,
      };
      chunksData.push(chunk);
      await upsertChunk(chunk as Required<Chunk>);
    }

    doc.chunks = chunksData;
    doc.vectorsCount = chunksData.length;
    doc.status = "Synced";
    doc.lastSync = new Date().toLocaleTimeString("en-US", { hour12: false });
    await upsertSource({
      id: doc.id, name: doc.name, type: doc.type, status: "Synced", lastSync: doc.lastSync,
      vectorsCount: doc.vectorsCount, owner: doc.ownerName, ownerAvatar: "", ownerId: doc.ownerId,
      isShared: false, content: doc.content,
    });

    return { sourceId: doc.id, name: doc.name, chunkCount: chunksData.length };
  } catch (err) {
    // Roll back the partial source so a retry with the same id does not 409.
    store.sources = store.sources.filter(s => s.id !== doc.id);
    try { await deleteChunksBySource(doc.id); } catch { /* best effort */ }
    try { await deleteSource(doc.id); } catch { /* best effort */ }
    throw err;
  }
}
