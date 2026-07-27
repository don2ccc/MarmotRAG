/**
 * scripts/test-pipelines.mjs
 * Integration test: Pipeline CRUD + query routing via /api/pipelines and /api/query.
 * Run with:  node scripts/test-pipelines.mjs
 * Requires the dev server to be running on http://localhost:3000
 */

const BASE = "http://localhost:3000";

let passed = 0;
let failed = 0;

function ok(label, condition, detail = "") {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.error(`  ❌ ${label}${detail ? " — " + detail : ""}`);
    failed++;
  }
}

async function get(path) {
  const r = await fetch(`${BASE}${path}`);
  return { status: r.status, body: await r.json() };
}

async function post(path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
}

async function put(path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
}

async function del(path) {
  const r = await fetch(`${BASE}${path}`, { method: "DELETE" });
  return { status: r.status, body: await r.json() };
}

// ── 1. GET /api/pipelines ──────────────────────────────────────────────────
console.log("\n1. GET /api/pipelines — seed data");
const list1 = await get("/api/pipelines");
ok("returns 200", list1.status === 200);
ok("is an array", Array.isArray(list1.body));
ok("has ≥ 3 seed pipelines", list1.body.length >= 3, `got ${list1.body.length}`);
const seedNames = list1.body.map(p => p.name);
ok("Doc-Search-Alpha present", seedNames.includes("Doc-Search-Alpha"));
ok("Legal-Brief-Retriever present", seedNames.includes("Legal-Brief-Retriever"));
ok("Customer-Support-LLM present", seedNames.includes("Customer-Support-LLM"));
ok("each pipeline has stats", list1.body.every(p => p.stats && "queryCount" in p.stats));

// ── 2. POST /api/pipelines — create ───────────────────────────────────────
console.log("\n2. POST /api/pipelines — create");
const payload = {
  name: "Test-Pipeline-Script",
  description: "Created by integration test",
  generationModel: "offline",
  topK: 2,
  minScore: 0.1,
  systemPrompt: "Test system prompt.",
  sourceFilter: [],
  enabled: true,
};
const create = await post("/api/pipelines", payload);
ok("returns 201", create.status === 201, `got ${create.status}: ${JSON.stringify(create.body)}`);
ok("body has id", typeof create.body.id === "string");
ok("name matches", create.body.name === payload.name);
ok("topK matches", create.body.topK === payload.topK);
ok("minScore matches", create.body.minScore === payload.minScore);
const createdId = create.body.id;

// ── 3. POST — duplicate name should 409 ───────────────────────────────────
console.log("\n3. POST — duplicate name conflict");
const dup = await post("/api/pipelines", { ...payload });
ok("returns 409 for duplicate name", dup.status === 409, `got ${dup.status}`);

// ── 4. PUT /api/pipelines/:id — update ────────────────────────────────────
console.log("\n4. PUT /api/pipelines/:id — update");
const update = await put(`/api/pipelines/${createdId}`, { topK: 7, description: "Updated description" });
ok("returns 200", update.status === 200, `got ${update.status}`);
ok("topK updated", update.body.topK === 7, `got ${update.body.topK}`);
ok("description updated", update.body.description === "Updated description");
ok("name unchanged", update.body.name === payload.name);

// ── 5. PUT — name clash with existing pipeline ────────────────────────────
console.log("\n5. PUT — name clash with existing pipeline");
const clash = await put(`/api/pipelines/${createdId}`, { name: "Doc-Search-Alpha" });
ok("returns 409 for name clash", clash.status === 409, `got ${clash.status}`);

// ── 6. GET — verify updated pipeline visible in list ─────────────────────
console.log("\n6. GET — updated pipeline appears in list");
const list2 = await get("/api/pipelines");
const updated = list2.body.find(p => p.id === createdId);
ok("pipeline in list", !!updated);
ok("reflects topK=7", updated?.topK === 7);

// ── 7. Disable via PUT then verify playground filter logic ────────────────
console.log("\n7. PUT — disable pipeline");
const disable = await put(`/api/pipelines/${createdId}`, { enabled: false });
ok("returns 200", disable.status === 200);
ok("enabled is false", disable.body.enabled === false);

// ── 8. DELETE /api/pipelines/:id ─────────────────────────────────────────
console.log("\n8. DELETE /api/pipelines/:id");
const remove = await del(`/api/pipelines/${createdId}`);
ok("returns 200", remove.status === 200, `got ${remove.status}`);
ok("message present", typeof remove.body.message === "string");

const list3 = await get("/api/pipelines");
const stillThere = list3.body.find(p => p.id === createdId);
ok("pipeline removed from list", !stillThere);

// ── 9. DELETE — non-existent id should 404 ────────────────────────────────
console.log("\n9. DELETE — non-existent id");
const badDel = await del(`/api/pipelines/nonexistent-id-000`);
ok("returns 404", badDel.status === 404, `got ${badDel.status}`);

// ── 10. /api/query — pipeline resolution ─────────────────────────────────
console.log("\n10. /api/query — pipeline routing (offline)");
// Create an offline pipeline to avoid needing Gemini key
const offline = await post("/api/pipelines", {
  name: "Offline-Test-Query",
  description: "Offline pipeline for query routing test",
  generationModel: "offline",
  topK: 1,
  minScore: 0.0,
  systemPrompt: "",
  sourceFilter: [],
  enabled: true,
});
ok("offline pipeline created", offline.status === 201, `got ${offline.status}: ${JSON.stringify(offline.body)}`);

const qr = await post("/api/query", { query: "test query for routing", pipeline: "Offline-Test-Query" });
ok("query returns 200", qr.status === 200, `got ${qr.status}: ${JSON.stringify(qr.body)}`);
ok("response has answer", typeof qr.body.answer === "string");
ok("response has chunks array", Array.isArray(qr.body.chunks));
ok("pipeline echoed back", qr.body.pipeline === "Offline-Test-Query");

// Cleanup offline test pipeline
const offlineId = offline.body.id;
await del(`/api/pipelines/${offlineId}`);

// ── Summary ───────────────────────────────────────────────────────────────
console.log(`\n${"─".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error("Some tests FAILED. Check the server logs.");
  process.exit(1);
} else {
  console.log("All tests PASSED ✅");
}
