import { embedText } from "./embeddings.js";
import {
  searchLexical,
  searchVector,
  type CandidateRow,
  type SearchFilter,
} from "./db.js";
import { chunkText, countTokens, chunkWithPolicy, resolvePolicy } from "./chunking.js";

// Chunking and token counting live in ./chunking.ts (pure, unit-tested).
// Re-exported here because existing callers import them from retrieval.
export { chunkText, countTokens, chunkWithPolicy, resolvePolicy };

/** One citable unit. `citationId` is what an agent must quote back. */
export interface Citation {
  citationId: string;
  chunkId: string;
  docId: string;
  docNo: string | null;
  kind: string;
  title: string;
  versionNo: number;
  clauseNo: string | null;
  clausePath: string | null;
  page: number | null;
  charRange: [number, number] | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  lifecycle: string;
  score: number;
}

export interface RetrievedChunk {
  citationId: string;
  chunkId: string;
  sourceId: string;
  sourceName: string;
  text: string;
  score: number;
  tokenCount: number;
  versionNo: number;
  clauseNo: string | null;
  clausePath: string | null;
}

export interface RetrievalDiagnostics {
  vectorHits: number;
  lexicalHits: number;
  fused: number;
  returned: number;
  deduped: number;
  bestScore: number;
  scoreGap: number;
  degraded: boolean;
  reranked: boolean;
  lexicalKeys: string[];
  tookMs: number;
}

export interface RetrieveResult {
  query: string;
  /** Stable id for this retrieval; quote it when sending feedback. */
  retrievalId: string;
  /** hit = usable, weak = low confidence, empty = nothing found. */
  status: "hit" | "weak" | "empty";
  citations: Citation[];
  /** Backwards-compatible view used by the dashboard. */
  chunks: RetrievedChunk[];
  context: string;
  diagnostics: RetrievalDiagnostics;
  latencyMs: number;
}

export type RetrievalMode = "fast" | "balanced" | "deep";

export interface RetrieveOptions {
  query: string;
  userId: string;
  topK?: number;                 // default 5, clamped 1..50
  minScore?: number;             // default 0, clamped 0..1
  sourceFilter?: string[];       // caller-level allowlist
  extraSourceFilter?: string[];  // agent-key-level allowlist (intersected)
  kinds?: string[];              // policy | process | contract | template | ...
  docIds?: string[];
  asOf?: string | null;          // ISO timestamp: ask the past
  includeExpired?: boolean;
  mode?: RetrievalMode;
  /** 0 = pure relevance, 1 = maximum diversity. Default 0.7 relevance. */
  diversity?: number;
}

const RRF_K = 60;
const WEAK_SCORE_THRESHOLD = 0.35;
const NEAR_DUPLICATE_JACCARD = 0.9;

/** Candidate depth per channel, by mode. */
const MODE_PRESETS: Record<RetrievalMode, { multiplier: number; mmr: boolean; lexical: number }> = {
  fast: { multiplier: 2, mmr: false, lexical: 20 },
  balanced: { multiplier: 4, mmr: true, lexical: 40 },
  deep: { multiplier: 8, mmr: true, lexical: 80 },
};

const LEGAL_REF = /第\s*[一二三四五六七八九十百千零〇两\d]+\s*[编篇章节目条款项]/g;
const DOC_NUMBER = /[\u4e00-\u9fa5]{1,10}〔\s*\d{4}\s*〕\s*\d+\s*号/g;
const ALNUM_TOKEN = /[A-Za-z][A-Za-z0-9._/-]{2,}/g;
const LONG_NUMBER = /\b\d{6,}\b/g;

const STOPWORDS = new Set([
  "the", "and", "for", "with", "what", "when", "where", "which", "how", "does", "did",
  "was", "were", "are", "this", "that", "from", "into", "about", "please", "tell",
]);

/**
 * Pull out the tokens that embeddings are bad at: 文号, 合同编号, 料号, 条款号,
 * long numeric ids. Only these drive the lexical channel — running trigram
 * similarity over a whole natural-language question adds noise, not recall.
 */
export function extractLexicalKeys(query: string): string[] {
  const keys = new Set<string>();
  for (const pattern of [LEGAL_REF, DOC_NUMBER, ALNUM_TOKEN, LONG_NUMBER]) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(query)) !== null) {
      const token = match[0].trim();
      if (!token) continue;
      if (pattern === ALNUM_TOKEN) {
        if (token.length < 3) continue;
        if (!/\d/.test(token) && !/[A-Z]/.test(token)) continue;
        if (STOPWORDS.has(token.toLowerCase())) continue;
      }
      keys.add(token);
      if (keys.size >= 8) break;
    }
    if (keys.size >= 8) break;
  }
  return [...keys];
}

/** Character trigrams — a cheap, language-agnostic similarity for near-duplicates. */
function trigrams(text: string): Set<string> {
  const normalized = text.replace(/\s+/g, "").toLowerCase();
  const set = new Set<string>();
  for (let i = 0; i + 3 <= normalized.length; i++) set.add(normalized.slice(i, i + 3));
  if (set.size === 0 && normalized.length > 0) set.add(normalized);
  return set;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const gram of small) if (large.has(gram)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

interface FusedCandidate {
  row: CandidateRow;
  rrf: number;
  relevance: number;
}

/** Reciprocal rank fusion over the vector and lexical channels. */
function fuse(vectorRows: CandidateRow[], lexicalRows: CandidateRow[]): FusedCandidate[] {
  const byId = new Map<string, FusedCandidate>();

  const add = (rows: CandidateRow[], weight: number): void => {
    rows.forEach((row, index) => {
      const contribution = weight * (1 / (RRF_K + index + 1));
      const existing = byId.get(row.id);
      if (existing) {
        existing.rrf += contribution;
      } else {
        byId.set(row.id, { row, rrf: contribution, relevance: 0 });
      }
    });
  };

  add(vectorRows, 1);
  add(lexicalRows, 1);

  const fused = [...byId.values()].sort((a, b) => b.rrf - a.rrf);
  const max = fused[0]?.rrf ?? 1;
  for (const item of fused) item.relevance = item.rrf / max;
  return fused;
}

/**
 * Maximal marginal relevance: keep candidates that add information, drop ones
 * that mostly repeat a pick already made. This is what stops ten boilerplate
 * contract clauses from filling the context window.
 */
function mmrSelect(
  candidates: FusedCandidate[],
  limit: number,
  lambda: number
): FusedCandidate[] {
  const selected: FusedCandidate[] = [];
  const selectedGrams: Set<string>[] = [];
  const pool = [...candidates];
  const gramsById = new Map(pool.map(c => [c.row.id, trigrams(c.row.text)]));

  while (selected.length < limit && pool.length > 0) {
    let bestIndex = -1;
    let bestValue = Number.NEGATIVE_INFINITY;

    for (let i = 0; i < pool.length; i++) {
      const candidate = pool[i];
      const grams = gramsById.get(candidate.row.id) as Set<string>;
      let maxSimilarity = 0;
      for (const chosen of selectedGrams) {
        const similarity = jaccard(grams, chosen);
        if (similarity > maxSimilarity) maxSimilarity = similarity;
      }
      const value = lambda * candidate.relevance - (1 - lambda) * maxSimilarity;
      if (value > bestValue) {
        bestValue = value;
        bestIndex = i;
      }
    }

    if (bestIndex < 0) break;
    const [chosen] = pool.splice(bestIndex, 1);
    const grams = gramsById.get(chosen.row.id) as Set<string>;

    // Hard-drop near duplicates instead of merely penalising them: otherwise a
    // repeated boilerplate clause can still surface when the pool is small.
    const isDuplicate = selectedGrams.some(g => jaccard(grams, g) >= NEAR_DUPLICATE_JACCARD);
    if (isDuplicate && pool.length > 0) continue;

    selected.push(chosen);
    selectedGrams.push(grams);
  }

  return selected;
}

function toCitation(chosen: FusedCandidate, index: number): Citation {
  const row = chosen.row;
  return {
    citationId: `c${index + 1}`,
    chunkId: row.id,
    docId: row.docId,
    docNo: row.docNo,
    kind: row.kind,
    title: row.sourceName,
    versionNo: row.versionNo,
    clauseNo: row.clauseNo,
    clausePath: row.clausePath,
    page: row.pageFrom,
    charRange: row.charStart !== null && row.charEnd !== null ? [row.charStart, row.charEnd] : null,
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
    lifecycle: row.lifecycle,
    score: Math.round(row.score * 10000) / 10000,
  };
}

function renderContext(chunks: RetrievedChunk[]): string {
  return chunks
    .map((chunk, index) => {
      const where = [chunk.clausePath ?? chunk.clauseNo, `v${chunk.versionNo}`]
        .filter(Boolean)
        .join(" · ");
      return `[c${index + 1}] 《${chunk.sourceName}》${where ? ` ${where}` : ""}\n${chunk.text}`;
    })
    .join("\n\n");
}

/**
 * Core retrieval used by both the dashboard and the Agent API.
 *
 * Pipeline: embed → vector channel + lexical channel → RRF → exact dedupe →
 * MMR → citations. If the embedding server is unavailable the lexical channel
 * still answers (degraded), which keeps identifier lookups alive during an
 * outage instead of failing the whole request.
 */
export async function retrieveCore(opts: RetrieveOptions): Promise<RetrieveResult> {
  const startedAt = Date.now();
  const topK = Math.max(1, Math.min(50, opts.topK ?? 5));
  const minScore = Math.max(0, Math.min(1, opts.minScore ?? 0));
  const mode = opts.mode ?? "balanced";
  const preset = MODE_PRESETS[mode] ?? MODE_PRESETS.balanced;
  const lambda = Math.max(0, Math.min(1, opts.diversity ?? 0.7));

  const caller = opts.sourceFilter?.length ? opts.sourceFilter : undefined;
  const extra = opts.extraSourceFilter?.length ? opts.extraSourceFilter : undefined;
  const effectiveFilter = caller && extra
    ? caller.filter(id => extra.includes(id))
    : (caller ?? extra);

  const filter: SearchFilter = {
    userId: opts.userId,
    sourceFilter: effectiveFilter,
    kinds: opts.kinds,
    docIds: opts.docIds,
    asOf: opts.asOf ?? null,
    includeExpired: opts.includeExpired,
  };

  const lexicalKeys = extractLexicalKeys(opts.query);
  const candidateDepth = Math.min(200, topK * preset.multiplier);

  let vectorRows: CandidateRow[] = [];
  let degraded = false;
  let embedError: unknown = null;

  try {
    const embedding = await embedText(opts.query);
    vectorRows = await searchVector(embedding, candidateDepth, filter);
  } catch (err) {
    embedError = err;
    degraded = true;
    if (lexicalKeys.length === 0) throw err;
  }

  let lexicalRows: CandidateRow[] = [];
  if (lexicalKeys.length > 0) {
    try {
      lexicalRows = await searchLexical(lexicalKeys, preset.lexical, filter);
    } catch (err) {
      // A lexical failure must not break a vector-only result.
      if (vectorRows.length === 0) throw err;
      console.warn("[retrieval] lexical channel failed:", err);
    }
  }

  let fused = fuse(vectorRows, lexicalRows);

  if (minScore > 0) {
    fused = fused.filter(item => item.row.score >= minScore);
  }

  // Exact duplicates (same normalised text indexed twice) carry no extra signal.
  const seenHashes = new Set<string>();
  const deduped: FusedCandidate[] = [];
  let duplicateCount = 0;
  for (const item of fused) {
    const key = item.row.contentSha256 ?? item.row.text.replace(/\s+/g, " ").trim();
    if (seenHashes.has(key)) {
      duplicateCount++;
      continue;
    }
    seenHashes.add(key);
    deduped.push(item);
  }

  const ranked = preset.mmr ? mmrSelect(deduped, topK, lambda) : deduped.slice(0, topK);

  const citations = ranked.map(toCitation);
  const chunks: RetrievedChunk[] = ranked.map((item, index) => ({
    citationId: citations[index].citationId,
    chunkId: item.row.id,
    sourceId: item.row.sourceId,
    sourceName: item.row.sourceName,
    text: item.row.text,
    score: citations[index].score,
    tokenCount: item.row.tokensCount,
    versionNo: item.row.versionNo,
    clauseNo: item.row.clauseNo,
    clausePath: item.row.clausePath,
  }));

  const bestScore = ranked[0]?.row.score ?? 0;
  const scoreGap = ranked.length > 1 ? bestScore - ranked[1].row.score : bestScore;
  const threshold = Math.max(minScore, WEAK_SCORE_THRESHOLD);
  const status: RetrieveResult["status"] =
    ranked.length === 0 ? "empty" : bestScore < threshold ? "weak" : "hit";

  const tookMs = Date.now() - startedAt;

  return {
    query: opts.query,
    retrievalId: `rtv-${crypto.randomUUID()}`,
    status,
    citations,
    chunks,
    context: renderContext(chunks),
    diagnostics: {
      vectorHits: vectorRows.length,
      lexicalHits: lexicalRows.length,
      fused: fused.length,
      returned: ranked.length,
      deduped: duplicateCount,
      bestScore: Math.round(bestScore * 10000) / 10000,
      scoreGap: Math.round(scoreGap * 10000) / 10000,
      degraded: degraded && embedError !== null,
      reranked: preset.mmr,
      lexicalKeys,
      tookMs,
    },
    latencyMs: tookMs,
  };
}
