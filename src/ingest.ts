import {
  deleteChunksBySource,
  deleteSource,
  updateSourceMeta,
  upsertSource,
} from "./db.js";
import { indexSource, policyFromConfig } from "./indexing.js";
import { store } from "./store.js";
import type { SourceDoc } from "./types.js";

export interface IngestResult {
  sourceId: string;
  name: string;
  chunkCount: number;
  lastSync: string;
  versionNo: number;
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
  /** "percent" (default) or legacy "tokens" — see resolvePolicy(). */
  chunkOverlapUnit?: string;
  /** Document metadata written to marmot_sources. */
  kind?: string;
  docNo?: string | null;
  /** Editorial validity written to the new version. */
  lifecycle?: string;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
  signedAt?: string | null;
  /** True when this call creates a new version of an existing document. */
  replaceExisting?: boolean;
}

/**
 * Chunk → embed → persist a source.
 *
 * Creates the document on first write; adds a new version when `replaceExisting`
 * is set. Chunks are written as a shadow version and switched in atomically, so
 * a failure never leaves a half-indexed document and never removes the version
 * that is currently being served.
 */
export async function ingestText(opts: IngestOptions): Promise<IngestResult> {
  const policy = policyFromConfig({
    chunkSize: opts.chunkSize,
    chunkOverlap: opts.chunkOverlap,
    chunkOverlapUnit: opts.chunkOverlapUnit,
    separationStrategy: opts.strategy,
  });

  const isNew = !opts.replaceExisting && !store.sources.some(s => s.id === opts.id);

  if (isNew) {
    const doc: SourceDoc = {
      id: opts.id,
      name: opts.name,
      type: opts.type,
      status: "Syncing...",
      lastSync: "",
      vectorsCount: 0,
      ownerId: opts.ownerId,
      ownerName: opts.ownerName,
      isShared: false,
      content: opts.content,
      chunks: [],
      kind: opts.kind ?? "document",
      docNo: opts.docNo ?? null,
    };

    await upsertSource({
      id: doc.id, name: doc.name, type: doc.type, status: doc.status, lastSync: doc.lastSync,
      vectorsCount: 0, owner: doc.ownerName, ownerAvatar: "", ownerId: doc.ownerId,
      isShared: false, content: doc.content,
    });
    await updateSourceMeta(doc.id, { kind: doc.kind, docNo: doc.docNo ?? null });
    store.sources.unshift(doc);
  } else {
    // Existing document: metadata changes apply to the document row, content
    // changes become a new version.
    await updateSourceMeta(opts.id, {
      name: opts.name,
      type: opts.type,
      kind: opts.kind,
      docNo: opts.docNo,
    });
    const doc = store.sources.find(s => s.id === opts.id);
    if (doc) {
      doc.name = opts.name;
      doc.type = opts.type;
      if (opts.kind !== undefined) doc.kind = opts.kind;
      if (opts.docNo !== undefined) doc.docNo = opts.docNo;
    }
  }

  try {
    const result = await indexSource({
      sourceId: opts.id,
      sourceName: opts.name,
      content: opts.content,
      chunkSize: policy.chunkSize,
      chunkOverlapPercent: policy.chunkOverlapPercent,
      strategy: policy.strategy,
      lifecycle: opts.lifecycle,
      effectiveFrom: opts.effectiveFrom,
      effectiveTo: opts.effectiveTo,
      signedAt: opts.signedAt,
    });

    const doc = store.sources.find(s => s.id === opts.id);
    if (doc) {
      doc.status = "Synced";
      doc.vectorsCount = result.chunkCount;
      doc.lastSync = result.lastSync;
      doc.content = opts.content;
    }

    return {
      sourceId: opts.id,
      name: opts.name,
      chunkCount: result.chunkCount,
      lastSync: result.lastSync,
      versionNo: result.versionNo,
    };
  } catch (err) {
    if (isNew) {
      // A brand-new document that failed has nothing to keep; the caller may
      // retry with the same id.
      store.sources = store.sources.filter(s => s.id !== opts.id);
      try { await deleteChunksBySource(opts.id); } catch { /* best effort */ }
      try { await deleteSource(opts.id); } catch { /* best effort */ }
    }
    throw err;
  }
}
