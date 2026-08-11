import { requireCjs } from "./cjs.js";
import { embedText } from "./embeddings.js";
import { searchChunks } from "./db.js";

// jieba-wasm: CJK-aware tokenizer (Rust/WASM, no native build needed)
const jieba = requireCjs("jieba-wasm") as unknown as { cut: (text: string, hmm: boolean) => string[] };

export interface RetrievedChunk {
  chunkId: string;
  sourceId: string;
  sourceName: string;
  text: string;
  score: number;
  tokenCount: number;
}

export interface RetrieveResult {
  query: string;
  chunks: RetrievedChunk[];
  context: string;
  latencyMs: number;
}

export interface RetrieveOptions {
  query: string;
  userId: string;                // visibility: own + shared
  topK?: number;                 // default 5, clamped 1..50
  minScore?: number;             // default 0, clamped 0..1
  sourceFilter?: string[];       // caller-level allowlist
  extraSourceFilter?: string[];  // agent-key-level allowlist (intersected)
}

/**
 * Count tokens in a text string using jieba for CJK content.
 * jieba.cut returns individual words/chars; filter out pure-whitespace tokens.
 */
export function countTokens(text: string): number {
  return jieba.cut(text, false).filter(t => t.trim().length > 0).length;
}

/**
 * Split text into chunks using jieba-aware token counting.
 * - "Semantic": sentence-boundary sliding window (CJK + Latin punctuation)
 * - "Fixed": sliding window by token count
 * - "Paragraph"/"Recursive": split on blank lines, fallback to Fixed for long paragraphs
 *
 * `size` = max tokens per chunk (jieba tokens, ~1 CJK word each)
 * `overlap` = number of tokens to carry over between chunks
 */
export function chunkText(text: string, size: number, overlap: number, strategy: string): string[] {
  const chunks: string[] = [];
  const totalTokens = countTokens(text);

  if (strategy === "Fixed" || totalTokens < size / 2) {
    const tokens = jieba.cut(text, false).filter(t => t.trim().length > 0);
    const stride = Math.max(1, size - overlap);
    for (let i = 0; i < tokens.length; i += stride) {
      const slice = tokens.slice(i, i + size);
      if (slice.length > 0) chunks.push(slice.join(""));
      if (i + size >= tokens.length) break;
    }
  } else if (strategy === "Semantic") {
    const sentences = text.match(/[^.!?。！？\n]+[.!?。！？\n]+/g) || [text];
    let currentChunk: string[] = [];
    let currentLen = 0;

    for (const sentence of sentences) {
      const sentenceLen = countTokens(sentence);
      if (currentLen + sentenceLen > size && currentChunk.length > 0) {
        chunks.push(currentChunk.join(""));
        let overlapLen = 0;
        const overlapChunk: string[] = [];
        for (let j = currentChunk.length - 1; j >= 0; j--) {
          const wc = countTokens(currentChunk[j]);
          if (overlapLen + wc <= overlap) {
            overlapChunk.unshift(currentChunk[j]);
            overlapLen += wc;
          } else break;
        }
        currentChunk = overlapChunk;
        currentLen = overlapLen;
      }
      currentChunk.push(sentence.trim());
      currentLen += sentenceLen;
    }
    if (currentChunk.length > 0) chunks.push(currentChunk.join(""));
  } else {
    // Paragraph / Recursive strategy
    const paragraphs = text.split(/\n\s*\n+/);
    for (const para of paragraphs) {
      if (countTokens(para) <= size) {
        chunks.push(para.trim());
      } else {
        chunks.push(...chunkText(para, size, overlap, "Fixed"));
      }
    }
  }
  return chunks.filter(c => c.trim().length > 0);
}

/**
 * Core retrieval used by both the internal dashboard (Playground) and the
 * Agent API. Visibility is always enforced: only the given user's own
 * sources plus platform-shared sources (both Synced) can be returned.
 */
export async function retrieveCore(opts: RetrieveOptions): Promise<RetrieveResult> {
  const startTime = Date.now();
  const topK = Math.max(1, Math.min(50, opts.topK ?? 5));
  const minScore = Math.max(0, Math.min(1, opts.minScore ?? 0));

  const queryEmbedding = await embedText(opts.query);

  // Merge caller allowlist with agent-key allowlist (intersection).
  const caller = opts.sourceFilter?.length ? opts.sourceFilter : undefined;
  const extra = opts.extraSourceFilter?.length ? opts.extraSourceFilter : undefined;
  const effectiveFilter = caller && extra
    ? caller.filter(id => extra.includes(id))
    : (caller ?? extra);

  const rows = await searchChunks(queryEmbedding, topK * 2, {
    userId: opts.userId,
    sourceFilter: effectiveFilter,
  });
  const filtered = rows.filter(r => r.score >= minScore).slice(0, topK);

  const chunks: RetrievedChunk[] = filtered.map(r => ({
    chunkId: r.id,
    sourceId: r.sourceId,
    sourceName: r.sourceName,
    text: r.text,
    score: Math.round(r.score * 10000) / 10000,
    tokenCount: r.tokensCount,
  }));
  const context = chunks
    .map((c, i) => `[Document ${i + 1}: ${c.sourceName}]\n${c.text}`)
    .join("\n\n");

  return {
    query: opts.query,
    chunks,
    context,
    latencyMs: Date.now() - startTime,
  };
}
