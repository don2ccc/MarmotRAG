/**
 * Indexing pipeline: chunk → embed → write shadow version → atomic switch.
 *
 * Every write path (dashboard create, dashboard reindex, agent ingest, startup
 * seed, startup repair) goes through here, so they all share:
 *   - one chunker (chunking.ts)
 *   - one concurrency policy for embeddings
 *   - one version lifecycle, where a failure never removes the serving version
 */
import {
  chunkWithPolicy,
  resolvePolicy,
  MAX_CHUNK_CHARS,
  type ChunkPolicy,
  type ChunkPiece,
} from "./chunking.js";
import { embedRuntimeConfig, embedTexts, storeDim } from "./embeddings.js";
import {
  abortVersion,
  beginVersion,
  commitVersion,
  insertChunkRows,
  sha256,
} from "./db.js";

/** Chunks embedded per round trip; keeps memory flat on large documents. */
const EMBED_BATCH = 24;

/** Parallel embedding requests. The local server is the bottleneck, not us. */
const EMBED_CONCURRENCY = 3;

export interface IndexSourceOptions {
  sourceId: string;
  sourceName: string;
  content: string;
  /** Policy fields as persisted in marmot_config (see resolvePolicy). */
  chunkSize: number;
  chunkOverlapPercent: number;
  strategy: string;
  /** Editorial validity recorded on the new version. */
  lifecycle?: string;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
  signedAt?: string | null;
  onProgress?: (done: number, total: number) => void;
}

export interface IndexSourceResult {
  chunkCount: number;
  lastSync: string;
  versionId: string;
  versionNo: number;
}

/** Plan the chunks without embedding anything (used to report a total early). */
export function planChunks(content: string, policy: {
  chunkSize: number;
  chunkOverlapPercent: number;
  strategy: string;
}): ChunkPiece[] {
  return chunkWithPolicy(content, policy);
}

/** Fingerprint of everything that affects chunk boundaries. */
export function strategyFingerprint(policy: ChunkPolicy): string {
  return sha256(JSON.stringify({
    chunkSize: policy.chunkSize,
    chunkOverlapPercent: policy.chunkOverlapPercent,
    strategy: policy.strategy,
    maxChunkChars: MAX_CHUNK_CHARS,
  }));
}

/**
 * Rebuild one document into a new shadow version and switch to it on success.
 *
 * Throws after aborting the version; the caller decides whether the *document*
 * should be rolled back (agent create) or kept (reindex of an existing document).
 */
export async function indexSource(opts: IndexSourceOptions): Promise<IndexSourceResult> {
  const policy: ChunkPolicy = {
    chunkSize: opts.chunkSize,
    chunkOverlapPercent: opts.chunkOverlapPercent,
    strategy: opts.strategy,
  };

  const pieces = chunkWithPolicy(opts.content, policy);
  if (pieces.length === 0) {
    throw new Error("content produced no chunks");
  }

  const embedding = embedRuntimeConfig();
  const versionId = await beginVersion(opts.sourceId, {
    contentSha256: sha256(opts.content),
    strategyHash: strategyFingerprint(policy),
    embeddingModel: embedding.embedModel,
    embeddingDim: storeDim(),
    lifecycle: opts.lifecycle ?? "effective",
    effectiveFrom: opts.effectiveFrom ?? null,
    effectiveTo: opts.effectiveTo ?? null,
    signedAt: opts.signedAt ?? null,
  });

  let done = 0;

  try {
    for (let start = 0; start < pieces.length; start += EMBED_BATCH) {
      const batch = pieces.slice(start, start + EMBED_BATCH);
      const embeddings = await embedTexts(batch.map(p => p.text), EMBED_CONCURRENCY);

      await insertChunkRows(
        versionId,
        batch.map((piece, i) => ({
          id: `${opts.sourceId}::${versionId}::${start + i}`,
          sourceId: opts.sourceId,
          sourceName: opts.sourceName,
          ordinal: start + i,
          text: piece.text,
          tokensCount: piece.tokens,
          charStart: piece.charStart,
          charEnd: piece.charEnd,
          clauseNo: piece.clauseNo,
          clausePath: piece.clausePath,
          contentSha256: sha256(piece.text),
          embedInputChars: piece.text.length,
          embedding: embeddings[i],
        }))
      );

      done += batch.length;
      opts.onProgress?.(done, pieces.length);
    }

    const { lastSync, versionNo } = await commitVersion({
      docId: opts.sourceId,
      versionId,
      chunkCount: pieces.length,
    });

    return { chunkCount: pieces.length, lastSync, versionId, versionNo };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await abortVersion(opts.sourceId, versionId, reason).catch(abortErr => {
      console.error("[index] abortVersion failed:", abortErr);
    });
    throw err;
  }
}

/** Convenience wrapper for callers that hold the persisted strategy config. */
export function policyFromConfig(cfg: {
  chunkSize?: number;
  chunkOverlap?: number;
  chunkOverlapUnit?: string;
  separationStrategy?: string;
}): Required<ChunkPolicy> {
  return resolvePolicy(cfg);
}
