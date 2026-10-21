/**
 * Unit tests for the pure chunker (scripts/test-chunking.ts).
 *
 * These cover the invariants the indexing pipeline now depends on, and they run
 * without Postgres or the embedding server:
 *
 *   npm run test:chunking
 */
import {
  chunkWithPolicy,
  countTokens,
  resolvePolicy,
  MAX_CHUNK_CHARS,
} from "../src/chunking.ts";

let passed = 0;
let failed = 0;

function ok(label: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}${detail ? " — " + detail : ""}`);
    failed++;
  }
}

interface Range { charStart: number; charEnd: number }

/** Characters not covered by any chunk (whitespace excluded). */
function uncovered(text: string, pieces: (Range & { text: string })[]): number[] {
  const covered = new Uint8Array(text.length);
  for (const p of pieces) {
    for (let i = Math.max(0, p.charStart); i < Math.min(text.length, p.charEnd); i++) covered[i] = 1;
  }
  const gaps: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (!covered[i] && !/\s/.test(text[i])) gaps.push(i);
  }
  return gaps;
}

function describeGaps(text: string, gaps: number[]): string {
  return gaps.slice(0, 5).map(i => JSON.stringify(text.slice(Math.max(0, i - 5), i + 5))).join(" ");
}

const CN = [
  "国巨集团2024年第三季度毛利率达到38.5%，创历史新高。",
  "公司在被动元件领域保持领先地位，产品覆盖电阻、电容与电感。",
  "第二段：员工考勤制度规定，年休假天数随工龄增长。",
  "合同约定：任何一方违约，应向守约方支付合同总额百分之十的违约金。",
].join("\n\n");

// ── 1. Coverage: nothing is dropped ───────────────────────────────────
console.log("\n1. Coverage");
for (const strategy of ["Semantic", "Fixed", "Paragraph"]) {
  const pieces = chunkWithPolicy(CN, { chunkSize: 40, chunkOverlapPercent: 10, strategy });
  const gaps = uncovered(CN, pieces);
  ok(`${strategy}: no uncovered characters`, gaps.length === 0, describeGaps(CN, gaps));
  ok(`${strategy}: produces at least one chunk`, pieces.length > 0);
}

// ── 2. Character cap: split, never truncate ───────────────────────────
console.log("\n2. Character cap");
const longSentence = "甲".repeat(5000) + "。";
const longPieces = chunkWithPolicy(longSentence, { chunkSize: 2000, chunkOverlapPercent: 0, strategy: "Semantic" });
ok("every chunk <= MAX_CHUNK_CHARS", longPieces.every(p => p.text.length <= MAX_CHUNK_CHARS),
  `max=${Math.max(...longPieces.map(p => p.text.length))}`);
ok("long text still fully covered", uncovered(longSentence, longPieces).length === 0);
ok("long text produced multiple chunks", longPieces.length > 1, `got ${longPieces.length}`);

// ── 3. Trailing sentence without punctuation is kept ──────────────────
console.log("\n3. Trailing sentence");
const trailing = "第一条：本制度自发布之日起施行。第二条：本制度由人力资源部负责解释";
const trailingPieces = chunkWithPolicy(trailing, { chunkSize: 200, chunkOverlapPercent: 0, strategy: "Semantic" });
ok("text without a final punctuation mark is not dropped",
  trailingPieces.some(p => p.text.includes("负责解释")));
ok("trailing text is fully covered", uncovered(trailing, trailingPieces).length === 0);

// ── 4. Decimal points do not split a number ───────────────────────────
console.log("\n4. Decimal numbers");
const decimals = chunkWithPolicy("毛利率达到 38.5%，同比增长 1.2 个百分点。", {
  chunkSize: 6, chunkOverlapPercent: 0, strategy: "Semantic",
});
ok("38.5 stays inside one chunk", decimals.some(p => p.text.includes("38.5%")));
ok("no chunk ends with a decimal point", decimals.every(p => !/38\.$/.test(p.text)));

// ── 5. Latin spacing survives Fixed chunking ──────────────────────────
console.log("\n5. Latin spacing");
const english = "The quick brown fox jumps over the lazy dog near the river.";
const fixed = chunkWithPolicy(english, { chunkSize: 3, chunkOverlapPercent: 0, strategy: "Fixed" });
ok("words are not glued together", fixed.every(p => !/Thequick|quickbrown|brownfox/.test(p.text)));
ok("spaces are preserved", fixed.some(p => p.text.includes(" ")));
ok("English text is fully covered", uncovered(english, fixed).length === 0);

// ── 6. Token counting is CJK-aware and consistent ─────────────────────
console.log("\n6. Token counting");
const cjk500 = "国巨集团是一家被动元件制造商，主要产品包括电阻、电容和电感。".repeat(20);
const tokens = countTokens(cjk500);
ok("CJK token count is in a sane range", tokens > cjk500.length * 0.2 && tokens < cjk500.length, `${tokens} tokens for ${cjk500.length} chars`);
const tokenPieces = chunkWithPolicy(cjk500, { chunkSize: 100, chunkOverlapPercent: 0, strategy: "Fixed" });
ok("chunk.tokens equals countTokens(chunk.text)",
  tokenPieces.every(p => p.tokens === countTokens(p.text)),
  "token counts disagree with text");

// ── 7. Overlap really is a percentage ─────────────────────────────────
console.log("\n7. Overlap");
const repeated = Array.from({ length: 40 }, (_, i) =>
  `第${i + 1}条规定，员工应当遵守公司的各项规章制度，按时完成工作任务。`).join("");
const withOverlap = chunkWithPolicy(repeated, { chunkSize: 100, chunkOverlapPercent: 20, strategy: "Semantic" });
const overlaps = withOverlap.slice(1).filter((p, i) => p.charStart < withOverlap[i].charEnd);
ok("consecutive chunks overlap (20%)", overlaps.length > 0, `${overlaps.length}/${withOverlap.length - 1}`);
ok("overlap is smaller than chunk size", withOverlap.every((p, i) =>
  i === 0 || withOverlap[i - 1].charEnd - p.charStart < p.text.length * 3));

const noOverlap = chunkWithPolicy(repeated, { chunkSize: 100, chunkOverlapPercent: 0, strategy: "Semantic" });
ok("0% overlap means no shared ranges", noOverlap.slice(1).every((p, i) => p.charStart >= noOverlap[i].charEnd));

// ── 8. Policy resolution / legacy config migration ────────────────────
console.log("\n8. Policy resolution");
const p1 = resolvePolicy({ chunkSize: 200, chunkOverlap: 10, chunkOverlapUnit: "percent", separationStrategy: "Semantic" });
ok("percent unit passes through", p1.chunkOverlapPercent === 10 && p1.chunkSize === 200);
const p2 = resolvePolicy({ chunkSize: 200, chunkOverlap: 20, chunkOverlapUnit: "tokens", separationStrategy: "Semantic" });
ok("legacy token overlap is converted to 10%", p2.chunkOverlapPercent === 10, `got ${p2.chunkOverlapPercent}`);
const p3 = resolvePolicy({ chunkSize: 99999, chunkOverlap: 90, separationStrategy: "Nonsense" });
ok("oversized values are clamped", p3.chunkSize <= 2048 && p3.chunkOverlapPercent <= 50 && p3.strategy === "Semantic");

// ── 9. Empty input ────────────────────────────────────────────────────
console.log("\n9. Edge cases");
ok("empty input yields no chunks", chunkWithPolicy("   \n\n ", { chunkSize: 100, chunkOverlapPercent: 0, strategy: "Semantic" }).length === 0);
const tiny = chunkWithPolicy("一句话。", { chunkSize: 200, chunkOverlapPercent: 20, strategy: "Semantic" });
ok("tiny input yields exactly one chunk", tiny.length === 1 && tiny[0].text === "一句话。");

// ── 10. Clause strategy (制度 / 合同) ─────────────────────────────────
console.log("\n10. Clause strategy");
const policyDoc = [
  "第一章 总则",
  "第一条 为规范公司管理，制定本办法。",
  "第二条 本办法适用于全体员工。",
  "第二章 休假",
  "第三条 员工享有年休假。",
  "（一）工龄满一年不满十年的，年休假五天。",
  "（二）工龄满十年不满二十年的，年休假十天。",
  "第四条 年休假不得跨年累积。",
].join("\n");

const clauses = chunkWithPolicy(policyDoc, { chunkSize: 200, chunkOverlapPercent: 0, strategy: "Clause" });
ok("clause mode produces multiple chunks", clauses.length >= 5, `got ${clauses.length}`);
ok("every chunk carries a clause number", clauses.every(c => !!c.clauseNo));
ok("chapter context is recorded in the path",
  clauses.some(c => (c.clausePath ?? "").includes("第二章")),
  clauses.map(c => c.clausePath).join(" | "));
ok("items of one article become separate chunks",
  clauses.filter(c => (c.clausePath ?? "").includes("第三条")).length >= 3);
ok("two articles are never merged into one chunk",
  !clauses.some(c => c.text.includes("第一条") && c.text.includes("第二条")));
ok("clause mode still covers the whole text", uncovered(policyDoc, clauses).length === 0);

const englishClauseDoc = "Article 1\nThis Agreement is effective on signing.\nArticle 2\nEither party may terminate with notice.";
const englishClauses = chunkWithPolicy(englishClauseDoc, { chunkSize: 200, chunkOverlapPercent: 0, strategy: "Clause" });
ok("Article markers are detected", englishClauses.some(c => c.clauseNo === "Article 1"));
ok("English clauses cover the text", uncovered(englishClauseDoc, englishClauses).length === 0);

const plainText = "没有任何条款标记的普通文本，用来验证回退行为。".repeat(6);
const fallback = chunkWithPolicy(plainText, { chunkSize: 20, chunkOverlapPercent: 0, strategy: "Clause" });
ok("clause mode falls back when no markers exist", fallback.length > 1, `got ${fallback.length}`);
ok("fallback still covers the text", uncovered(plainText, fallback).length === 0);

const longClause = "第一条 " + "甲".repeat(3000) + "。\n第二条 末尾条款。";
const splitClause = chunkWithPolicy(longClause, { chunkSize: 200, chunkOverlapPercent: 0, strategy: "Clause" });
ok("an oversized clause is split, not truncated",
  splitClause.filter(c => c.clauseNo === "第一条").length > 1);
ok("split continuations share the clause number and are flagged",
  splitClause.some(c => c.continues === true && c.clauseNo === "第一条"));
ok("oversized clause still respects the character cap",
  splitClause.every(c => c.text.length <= MAX_CHUNK_CHARS));

console.log(`\nResult: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
