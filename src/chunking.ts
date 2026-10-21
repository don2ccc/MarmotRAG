/**
 * Pure chunking module — no database, no network.
 *
 * Kept separate from retrieval.ts so the splitting invariants can be unit
 * tested without a Postgres pool, and so every caller (dashboard ingest, agent
 * ingest, seed, reindex) goes through exactly one implementation.
 *
 * Invariants enforced here (see docs/P0-任务清单-制度流程合同.md):
 *   1. No content is dropped: the union of ChunkPiece ranges covers the whole
 *      input text (whitespace included).
 *   2. No chunk exceeds MAX_CHUNK_CHARS, and long input is *split*, never
 *      truncated, so the embedded text and the stored text are identical.
 *   3. `tokens` always comes from the same CJK-aware tokenizer used to size
 *      chunks — there is no second token-counting rule.
 *   4. `chunkOverlapPercent` really is a percentage of chunkSize.
 *   5. "Clause" strategy never merges two clauses into one chunk and records
 *      clause_no / clause_path for citation.
 */
import { createRequire } from "node:module";

// This module deliberately has no local imports: it is pure, testable with
// plain `node` (Node's type stripping), and never opens a database connection.
// The CJS require keeps working in the esbuild CJS bundle, where import.meta.url
// is replaced with undefined.
const requireCjs = createRequire(
  import.meta.url ||
  (typeof __filename !== "undefined" ? __filename : process.cwd() + "/chunking.ts")
);

const jieba = requireCjs("jieba-wasm") as unknown as {
  cut: (text: string, hmm: boolean) => string[];
};

/**
 * Hard character cap for one chunk.
 *
 * Must stay <= embeddings.MAX_CHARS: that is the length the embedding client
 * accepts before it starts dropping characters. Today it is 8000, so 2000
 * leaves a wide margin while staying comfortable for a 4B embedding model.
 */
export const MAX_CHUNK_CHARS = 2000;

export const MIN_CHUNK_SIZE = 32;
export const MAX_CHUNK_SIZE = 2048;

export type ChunkStrategy = "Semantic" | "Fixed" | "Paragraph" | "Recursive" | "Clause";

export interface ChunkPiece {
  text: string;
  /** jieba token count of `text` — the only token count in the system. */
  tokens: number;
  /** Offsets into the original text; `text === source.slice(charStart, charEnd)`. */
  charStart: number;
  charEnd: number;
  /** "第12条" / "5.2" / "Article 7" when the Clause strategy detected one. */
  clauseNo?: string;
  /** "第4章 休假 > 第12条 > 第2款". */
  clausePath?: string;
  /** True when this piece continues an over-long clause (same clauseNo). */
  continues?: boolean;
}

export interface ChunkPolicy {
  /** Maximum jieba tokens per chunk (also bounded by MAX_CHUNK_CHARS). */
  chunkSize: number;
  /** Overlap as a percentage of chunkSize, 0-50. Ignored by Clause strategy. */
  chunkOverlapPercent: number;
  strategy: string;
}

interface Atom {
  start: number;
  end: number;
  tokens: number;
  clauseNo?: string;
  clausePath?: string;
}

/** Count tokens with jieba (CJK-aware). Whitespace-only tokens are ignored. */
export function countTokens(text: string): number {
  if (!text) return 0;
  let n = 0;
  for (const t of jieba.cut(text, false)) {
    if (t.trim().length > 0) n++;
  }
  return n;
}

function tokenCountOf(text: string, start: number, end: number): number {
  return countTokens(text.slice(start, end));
}

/**
 * Sentence boundaries that survive CJK and Latin text.
 *
 * `。！？!?\n` always end a sentence. `.` only ends one when followed by
 * whitespace or end-of-input, so decimals (`38.5%`) and file names stay intact.
 */
const SENTENCE_RE = /[^。！？!?\n]+?(?:[。！？!?]|\n|\.(?=\s|$)|$)/g;

function sentenceAtoms(text: string): Atom[] {
  const atoms: Atom[] = [];
  SENTENCE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SENTENCE_RE.exec(text)) !== null) {
    if (m[0].length === 0) {
      SENTENCE_RE.lastIndex++;
      continue;
    }
    const start = m.index;
    const end = start + m[0].length;
    atoms.push({ start, end, tokens: tokenCountOf(text, start, end) });
  }
  return atoms;
}

// ── Clause detection (制度 / 合同) ─────────────────────────────────────

const CN_NUMERALS = "零〇一二三四五六七八九十百千两";

/**
 * One marker per clause boundary:
 *   第X编/篇/章 第X节 第X条 第X款 第X项
 *   Article 7 / Section 3.2 / Clause 5
 *   a line starting with "12.3 " (contract numbering)
 */
const CLAUSE_MARKER_RE = new RegExp(
  `(第\\s*[${CN_NUMERALS}\\d]+\\s*[编篇章节目条款项]` +
  `|Article\\s+\\d+(?:\\.\\d+)*` +
  `|Section\\s+\\d+(?:\\.\\d+)*` +
  `|Clause\\s+\\d+(?:\\.\\d+)*` +
  `|^[ \\t]*[（(][${CN_NUMERALS}\\d]{1,4}[）)][ \\t]?` +
  `|^[ \\t]*\\d+(?:\\.\\d+)+[ \\t])`,
  "gm"
);

type ClauseLevel = "chapter" | "section" | "article" | "item";

function markerLevel(label: string): ClauseLevel {
  const text = label.trim();
  if (/^[（(]/.test(text)) return "item";
  if (/^第.*[编篇]$/.test(text)) return "chapter";
  if (/^第.*章$/.test(text)) return "chapter";
  if (/^第.*节$/.test(text) || /^Section/i.test(text)) return "section";
  if (/^第.*[条款项]$/.test(text) || /^Article/i.test(text) || /^Clause/i.test(text)) {
    return /^第.*[款项]$/.test(text) ? "item" : "article";
  }
  return "article"; // numbered "12.3" style
}

/**
 * Split text at clause boundaries. Chapter/section markers only build the
 * citation path; article and item markers also start a new atom, so a single
 * 条 never shares a chunk with its neighbour.
 */
function clauseAtoms(text: string): Atom[] {
  interface Marker { index: number; end: number; label: string; level: ClauseLevel }
  const markers: Marker[] = [];

  CLAUSE_MARKER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CLAUSE_MARKER_RE.exec(text)) !== null) {
    const label = m[0].trim();
    if (!label) continue;
    markers.push({ index: m.index, end: m.index + m[0].length, label, level: markerLevel(label) });
  }
  if (markers.length === 0) return [];

  const atoms: Atom[] = [];

  // Preamble before the first marker (title, 目录, 前言).
  if (markers[0].index > 0) {
    const end = markers[0].index;
    if (text.slice(0, end).trim()) {
      atoms.push({ start: 0, end, tokens: tokenCountOf(text, 0, end) });
    }
  }

  let chapter = "";
  let section = "";
  let article = "";

  for (let i = 0; i < markers.length; i++) {
    const marker = markers[i];

    if (marker.level === "chapter") {
      chapter = marker.label;
      section = "";
      article = "";
      continue;
    }
    if (marker.level === "section") {
      section = marker.label;
      article = "";
      continue;
    }

    // Article and item markers start a new atom; it runs to the next marker of
    // any level, which never merges two clauses into one chunk.
    const end = markers[i + 1]?.index ?? text.length;
    if (end <= marker.index) continue;
    if (marker.level === "article") article = marker.label;

    const pathParts = [chapter, section, marker.level === "item" ? article : "", marker.label]
      .filter(part => part.length > 0);
    atoms.push({
      start: marker.index,
      end,
      tokens: tokenCountOf(text, marker.index, end),
      clauseNo: marker.label,
      clausePath: pathParts.join(" > "),
    });
  }

  // Chapter/section headings sit between atoms; absorb them into the following
  // atom so the heading is not silently dropped from the index.
  return absorbGapsForward(atoms, text);
}

/** Extend each atom's start back to the previous atom's end (headings, spacing). */
function absorbGapsForward(atoms: Atom[], text: string): Atom[] {
  if (atoms.length === 0) return [];
  atoms[0].start = 0;
  for (let i = 1; i < atoms.length; i++) {
    atoms[i].start = atoms[i - 1].end;
    atoms[i].tokens = tokenCountOf(text, atoms[i].start, atoms[i].end);
  }
  atoms[atoms.length - 1].end = text.length;
  atoms[atoms.length - 1].tokens = tokenCountOf(text, atoms[atoms.length - 1].start, text.length);
  return atoms;
}

function paragraphAtoms(text: string): Atom[] {
  const atoms: Atom[] = [];
  const re = /\n\s*\n+/g;
  let start = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > start) {
      atoms.push({ start, end: m.index, tokens: tokenCountOf(text, start, m.index) });
    }
    start = m.index + m[0].length;
  }
  if (start < text.length) {
    atoms.push({ start, end: text.length, tokens: tokenCountOf(text, start, text.length) });
  }
  return atoms;
}

/**
 * Character boundaries of jieba tokens, so a window can be cut out of the
 * original string instead of rebuilt with .join(""). The old join("") dropped
 * every space between Latin words.
 */
function tokenCharOffsets(text: string): number[] | null {
  const raw = jieba.cut(text, false);
  if (raw.join("") !== text) return null; // tokenizer normalized the input
  const offsets = new Array<number>(raw.length);
  let pos = 0;
  for (let i = 0; i < raw.length; i++) {
    offsets[i] = pos;
    pos += raw[i].length;
  }
  return offsets.length > 0 ? offsets : null;
}

function tokenWindows(text: string, size: number, overlapTokens: number): Atom[] {
  const atoms: Atom[] = [];
  const stride = Math.max(1, size - overlapTokens);
  const offsets = tokenCharOffsets(text);

  if (!offsets) {
    // Fallback: character windows sized from the observed chars-per-token ratio.
    const total = Math.max(1, countTokens(text));
    const charsPerToken = Math.max(1, Math.round(text.length / total));
    const winChars = Math.max(1, size * charsPerToken);
    const strideChars = Math.max(1, stride * charsPerToken);
    for (let s = 0; s < text.length; s += strideChars) {
      const e = Math.min(text.length, s + winChars);
      atoms.push({ start: s, end: e, tokens: tokenCountOf(text, s, e) });
      if (e >= text.length) break;
    }
    return atoms;
  }

  const raw = jieba.cut(text, false);
  let i = 0;
  while (i < raw.length) {
    let j = i;
    let tok = 0;
    while (j < raw.length && tok < size) {
      if (raw[j].trim().length > 0) tok++;
      j++;
    }
    const start = offsets[i];
    const end = j > i ? offsets[j - 1] + raw[j - 1].length : start;
    atoms.push({ start, end, tokens: Math.max(1, tok) });
    if (j >= raw.length) break;
    // Step back over `overlapTokens` real tokens so windows overlap.
    let back = 0;
    let k = j - 1;
    while (k > i && back < overlapTokens) {
      if (raw[k].trim().length > 0) back++;
      k--;
    }
    i = Math.max(i + 1, k + 1);
  }
  return atoms;
}

/**
 * Make atom ranges contiguous. Gaps are only ever whitespace/punctuation the
 * tokenizer or sentence regex skipped; absorbing them guarantees invariant 1.
 */
function absorbGaps(atoms: Atom[], text: string): Atom[] {
  if (atoms.length === 0) {
    return text.length > 0
      ? [{ start: 0, end: text.length, tokens: tokenCountOf(text, 0, text.length) }]
      : [];
  }
  atoms[0].start = 0;
  atoms[atoms.length - 1].end = text.length;
  for (let i = 0; i < atoms.length - 1; i++) {
    if (atoms[i].end < atoms[i + 1].start) {
      atoms[i].end = atoms[i + 1].start;
      atoms[i].tokens = tokenCountOf(text, atoms[i].start, atoms[i].end);
    }
  }
  return atoms;
}

/**
 * Cut [start,end) into pieces of at most `maxChars`, preferring a sentence
 * punctuation break and then whitespace. This is the "split, never truncate"
 * guarantee: the pieces cover the range exactly.
 */
function splitRange(text: string, start: number, end: number, maxChars: number): Array<[number, number]> {
  if (end - start <= maxChars) return [[start, end]];
  const out: Array<[number, number]> = [];
  let s = start;
  while (s < end) {
    let e = Math.min(end, s + maxChars);
    if (e < end) {
      const minCut = s + Math.floor(maxChars * 0.6);
      const window = text.slice(minCut, e);
      let cut = -1;
      const punct = /[。！？；;.!?\n]/g;
      let m: RegExpExecArray | null;
      while ((m = punct.exec(window)) !== null) cut = minCut + m.index + 1;
      if (cut <= s) {
        const lastSpace = window.search(/\s(?=[^\s]*$)/);
        if (lastSpace >= 0) cut = minCut + lastSpace + 1;
      }
      if (cut > s) e = cut;
    }
    out.push([s, e]);
    s = e;
  }
  return out;
}

function toPiece(text: string, atom: Atom): ChunkPiece {
  const raw = text.slice(atom.start, atom.end);
  const lead = raw.length - raw.trimStart().length;
  const trail = raw.length - raw.trimEnd().length;
  const s = atom.start + lead;
  const e = Math.max(s, atom.end - trail);
  const clean = text.slice(s, e);
  const piece: ChunkPiece = { text: clean, tokens: countTokens(clean), charStart: s, charEnd: e };
  if (atom.clauseNo) piece.clauseNo = atom.clauseNo;
  if (atom.clausePath) piece.clausePath = atom.clausePath;
  return piece;
}

export function clampChunkSize(value: number): number {
  const n = Number.isFinite(value) ? Math.round(value) : 200;
  return Math.max(MIN_CHUNK_SIZE, Math.min(MAX_CHUNK_SIZE, n));
}

export function clampOverlapPercent(value: number): number {
  const n = Number.isFinite(value) ? value : 0;
  return Math.max(0, Math.min(50, n));
}

export function normalizeStrategy(value: string | undefined | null): ChunkStrategy {
  const v = String(value ?? "").trim().toLowerCase();
  if (v === "fixed") return "Fixed";
  if (v === "paragraph") return "Paragraph";
  if (v === "recursive") return "Recursive";
  if (v === "clause") return "Clause";
  return "Semantic";
}

/**
 * Turn the persisted strategy config into a concrete policy.
 * Legacy configs stored `chunkOverlap` as a token count; `chunkOverlapUnit`
 * records that so the value is converted instead of silently reinterpreted.
 */
export function resolvePolicy(cfg?: {
  chunkSize?: number;
  chunkOverlap?: number;
  chunkOverlapUnit?: string;
  separationStrategy?: string;
}): Required<ChunkPolicy> {
  const chunkSize = clampChunkSize(Number(cfg?.chunkSize ?? 200));
  const rawOverlap = Number(cfg?.chunkOverlap ?? 10);
  const unit = String(cfg?.chunkOverlapUnit ?? "percent").toLowerCase();
  const percent = unit === "tokens" ? (rawOverlap / chunkSize) * 100 : rawOverlap;
  return {
    chunkSize,
    chunkOverlapPercent: clampOverlapPercent(percent),
    strategy: normalizeStrategy(cfg?.separationStrategy),
  };
}

/** Split `text` into chunk pieces according to the policy. */
export function chunkWithPolicy(text: string, policy: ChunkPolicy): ChunkPiece[] {
  const src = text ?? "";
  if (!src.trim()) return [];

  const size = clampChunkSize(policy.chunkSize);
  const overlapPercent = clampOverlapPercent(policy.chunkOverlapPercent);
  const overlapTokens = Math.min(size - 1, Math.round((size * overlapPercent) / 100));
  const strategy = normalizeStrategy(policy.strategy);

  // ── Clause strategy: one clause per chunk, no cross-clause merging ──
  if (strategy === "Clause") {
    const detected = clauseAtoms(src);
    const hasClauses = detected.some(atom => atom.clauseNo);

    if (hasClauses) {
      const pieces: ChunkPiece[] = [];
      for (const atom of detected) {
        for (const [s, e] of splitRange(src, atom.start, atom.end, MAX_CHUNK_CHARS)) {
          if (e <= s) continue;
          const piece = toPiece(src, { start: s, end: e, tokens: 0, clauseNo: atom.clauseNo, clausePath: atom.clausePath });
          if (!piece.text) continue;
          // A clause split across pieces keeps the same clauseNo; mark the
          // continuations so a citation never points at half a sentence silently.
          if (pieces.some(p => p.clauseNo === piece.clauseNo && p.clausePath === piece.clausePath)) {
            piece.continues = true;
          }
          pieces.push(piece);
        }
      }
      if (pieces.length > 0) return pieces;
    }
    // No clause markers found: fall back to sentence packing so a plain
    // document still chunks reasonably instead of becoming one huge block.
  }

  let atoms: Atom[];
  let preWindowed = false;

  if (strategy === "Fixed") {
    atoms = tokenWindows(src, size, overlapTokens);
    preWindowed = true;
  } else if (strategy === "Clause" || strategy === "Semantic") {
    atoms = absorbGaps(sentenceAtoms(src), src);
  } else {
    atoms = absorbGaps(paragraphAtoms(src), src);
  }

  // Enforce the character cap before packing, so an over-long sentence or
  // paragraph is split rather than embedded truncated.
  const capped: Atom[] = [];
  for (const atom of atoms) {
    for (const [s, e] of splitRange(src, atom.start, atom.end, MAX_CHUNK_CHARS)) {
      if (e <= s) continue;
      capped.push({ start: s, end: e, tokens: tokenCountOf(src, s, e) });
    }
  }
  if (capped.length === 0) return [];

  const pieces: ChunkPiece[] = [];

  if (preWindowed) {
    // Windows already carry their own overlap.
    for (const atom of capped) {
      const piece = toPiece(src, atom);
      if (piece.text) pieces.push(piece);
    }
    return pieces;
  }

  let i = 0;
  while (i < capped.length) {
    let j = i;
    let tokens = 0;
    while (j < capped.length && (j === i || tokens + capped[j].tokens <= size)) {
      tokens += capped[j].tokens;
      j++;
    }
    const piece = toPiece(src, {
      start: capped[i].start,
      end: capped[j - 1].end,
      tokens,
    });
    if (piece.text) pieces.push(piece);
    if (j >= capped.length) break;

    let carry = 0;
    let k = j - 1;
    while (k > i && carry + capped[k].tokens <= overlapTokens) {
      carry += capped[k].tokens;
      k--;
    }
    i = Math.max(i + 1, k + 1);
  }

  return pieces;
}

/**
 * Backwards-compatible shim: 3rd argument is an overlap in *tokens*.
 * New code should call chunkWithPolicy() with a percentage instead.
 */
export function chunkText(text: string, size: number, overlapTokens: number, strategy: string): string[] {
  const chunkSize = clampChunkSize(size);
  const percent = chunkSize > 0 ? (overlapTokens / chunkSize) * 100 : 0;
  return chunkWithPolicy(text, { chunkSize, chunkOverlapPercent: percent, strategy }).map(p => p.text);
}
