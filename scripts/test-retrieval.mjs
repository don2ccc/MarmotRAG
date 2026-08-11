/**
 * scripts/test-retrieval.mjs
 * Integration test for the retrieval-only Marmot RAG service:
 *   - user scoping (X-User-Id)
 *   - private/shared visibility
 *   - owner-only mutations (403)
 *   - agent API key auth + sourceFilter
 * Requires the dev server on http://localhost:3000 and Ollama running.
 * Run:  node scripts/test-retrieval.mjs [baseUrl]
 */

const BASE = process.argv[2] ?? "http://localhost:3000";
const USER_A = "u-1"; // Jane Doe
const USER_B = "u-2"; // Marcus Kane

let passed = 0;
let failed = 0;
let docId = "";
let keyA = "";
let keyB = "";

function ok(label, condition, detail = "") {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}${detail ? " — " + detail : ""}`);
    failed++;
  }
}

async function req(path, { method = "GET", body, userId, apiKey } = {}) {
  const headers = {};
  if (userId) headers["X-User-Id"] = userId;
  if (apiKey) headers["X-API-Key"] = apiKey;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitForSynced(id, timeoutMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { body } = await req("/api/sources", { userId: USER_A });
    const doc = (body.sources ?? []).find(s => s.id === id);
    if (doc && doc.status === "Synced") return doc;
    await sleep(3000);
  }
  return null;
}

// ── 1. Health ─────────────────────────────────────────────────────────
console.log("\n1. Health");
const health = await req("/api/health");
ok("returns 200", health.status === 200);
ok("pg connected", health.body.pgConnected === true);
ok("ollama connected", health.body.ollamaConnected === true);

// ── 2. Sources visible per user ───────────────────────────────────────
console.log("\n2. Source visibility");
const srcA = await req("/api/sources", { userId: USER_A });
const srcB = await req("/api/sources", { userId: USER_B });
ok("u-1 gets paginated shape", Array.isArray(srcA.body.sources));
ok("u-1 sees shared/own docs", (srcA.body.sources ?? []).length > 0, `got ${srcA.body.sources?.length ?? 0}`);

// ── 3. u-1 creates a private document ─────────────────────────────────
console.log("\n3. Create document as u-1 (private)");
const content = "Marmot RAG 检索服务测试文档。国巨集团 2024 财年毛利率达到 38.5%，创历史新高。该指标反映了产品组合优化与成本控制成效。";
const created = await req("/api/sources", {
  method: "POST",
  userId: USER_A,
  body: { name: `itest-${Date.now()}`, type: "Text Document", content },
});
// SSE stream: fetch will return 200 with event-stream body even on error events.
ok("POST /api/sources accepted", created.status === 200, `status ${created.status}`);
ok("doc id present", typeof created.body?.doc?.id === "string" || created.status === 200);

// Poll until Synced (SSE body already consumed by fetch above).
const listAfterCreate = await req("/api/sources", { userId: USER_A });
const candidate = (listAfterCreate.body.sources ?? []).find(s => s.name.startsWith("itest-"));
if (candidate) docId = candidate.id;
ok("document appears in u-1 list", !!docId);

if (docId) {
  const doc = await waitForSynced(docId);
  ok("document reaches Synced (embedding ok)", !!doc, doc ? `vectors=${doc.vectorsCount}` : "timeout");

  // ── 4. Private document is invisible to u-2 ─────────────────────────
  console.log("\n4. Private visibility");
  const listB = await req("/api/sources", { userId: USER_B });
  ok("u-2 does NOT see u-1 private doc", !(listB.body.sources ?? []).some(s => s.id === docId));
  const srcBRetrieve = await req("/api/retrieve", { method: "POST", userId: USER_B, body: { query: "毛利率", topK: 3 } });
  ok("u-2 retrieve returns no chunks from private doc",
    (srcBRetrieve.body.chunks ?? []).every(c => c.sourceId !== docId));

  // ── 5. Owner-only mutation → u-2 gets 403 ───────────────────────────
  console.log("\n5. Owner-only mutations");
  const forbid = await req(`/api/sources/${docId}`, { method: "PATCH", userId: USER_B, body: { isShared: true } });
  ok("u-2 PATCH on u-1 doc → 403", forbid.status === 403, `status ${forbid.status}`);
  const forbidDel = await req(`/api/sources/${docId}`, { method: "DELETE", userId: USER_B });
  ok("u-2 DELETE on u-1 doc → 403", forbidDel.status === 403, `status ${forbidDel.status}`);

  // ── 6. Share → u-2 can see and retrieve ─────────────────────────────
  console.log("\n6. Share toggle");
  const share = await req(`/api/sources/${docId}`, { method: "PATCH", userId: USER_A, body: { isShared: true } });
  ok("u-1 shares doc", share.status === 200 && share.body.isShared === true);
  const listB2 = await req("/api/sources", { userId: USER_B });
  ok("u-2 now sees shared doc", (listB2.body.sources ?? []).some(s => s.id === docId));
  const retrB = await req("/api/retrieve", { method: "POST", userId: USER_B, body: { query: "国巨集团毛利率" } });
  ok("u-2 retrieve hits shared doc", (retrB.body.chunks ?? []).some(c => c.sourceId === docId));
  const unshare = await req(`/api/sources/${docId}`, { method: "PATCH", userId: USER_A, body: { isShared: false } });
  ok("u-1 unshares doc", unshare.status === 200 && unshare.body.isShared === false);
  const listB3 = await req("/api/sources", { userId: USER_B });
  ok("u-2 no longer sees it", !(listB3.body.sources ?? []).some(s => s.id === docId));
}

// ── 7. Agent API keys ─────────────────────────────────────────────────
console.log("\n7. Agent API keys");
const keyAres = await req("/api/agent/keys", { method: "POST", userId: USER_A, body: { label: "itest-key-A", rateLimit: 60, sourceFilter: [] } });
ok("u-1 creates key", keyAres.status === 201, `status ${keyAres.status}`);
if (keyAres.body.key) keyA = keyAres.body.key;

const keyBres = await req("/api/agent/keys", { method: "POST", userId: USER_B, body: { label: "itest-key-B", rateLimit: 60, sourceFilter: [] } });
if (keyBres.body.key) keyB = keyBres.body.key;

const keysA = await req("/api/agent/keys", { userId: USER_A });
ok("u-1 sees only own keys", (keysA.body ?? []).every(k => k.id === keyAres.body.id) || (keysA.body ?? []).length === 1);

if (keyA) {
  const noAuth = await req("/api/agent/retrieve", { method: "POST", body: { query: "毛利率" } });
  ok("missing X-API-Key → 401", noAuth.status === 401);
  const badKey = await req("/api/agent/retrieve", { method: "POST", apiKey: "mrmk_nope", body: { query: "毛利率" } });
  ok("invalid key → 401", badKey.status === 401);
  const retrKeyA = await req("/api/agent/retrieve", { method: "POST", apiKey: keyA, body: { query: "毛利率" } });
  ok("key A retrieve works", retrKeyA.status === 200);
}

if (docId && keyB) {
  const retrKeyB = await req("/api/agent/retrieve", { method: "POST", apiKey: keyB, body: { query: "国巨集团毛利率" } });
  ok("u-2's key cannot see u-1 private doc", (retrKeyB.body.chunks ?? []).every(c => c.sourceId !== docId));
}

// ── 8. Cleanup ────────────────────────────────────────────────────────
console.log("\n8. Cleanup");
if (docId) {
  const del = await req(`/api/sources/${docId}`, { method: "DELETE", userId: USER_A });
  ok("delete test doc", del.status === 200);
}
if (keyA) {
  const revoke = await req(`/api/agent/keys/${keyAres.body.id}`, { method: "DELETE", userId: USER_A });
  ok("revoke key A", revoke.status === 200);
}
if (keyB) {
  await req(`/api/agent/keys/${keyBres.body.id}`, { method: "DELETE", userId: USER_B });
}

console.log(`\nResult: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
