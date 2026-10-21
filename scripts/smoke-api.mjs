/**
 * HTTP smoke test for the retrieval-only service.
 *
 * Covers the agent-facing contract end to end:
 *   - SSE create / re-index (shadow version lifecycle)
 *   - clause-aware citations (clauseNo / clausePath / versionNo)
 *   - lexical channel by 文号 (doc number)
 *   - controlled upsert (expectedVersion), as-of retrieval, expiry filtering
 *   - kind filters, feedback loop, agent read-before-write
 *
 * Requires a running server and an embedding endpoint, e.g.:
 *   node scripts/fake-embed-server.mjs 11434
 *   node .tmp-server/server.js
 *   node scripts/smoke-api.mjs http://127.0.0.1:3999
 */
const BASE = process.argv[2] ?? "http://127.0.0.1:3999";
const USER = "u-1";
const DOC_NO = "示例发〔2024〕12号";

let passed = 0;
let failed = 0;

function ok(label, condition, detail = "") {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}${detail ? " — " + detail : ""}`);
    failed++;
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

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
  const text = await res.text();
  let json = {};
  try { json = JSON.parse(text); } catch { /* SSE or empty */ }
  return { status: res.status, body: json, text };
}

/** POST an SSE endpoint and collect its events. */
async function sse(path, body, userId) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-User-Id": userId },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} → ${res.status} ${await res.text()}`);
  const text = await res.text();
  return [...text.matchAll(/^event: (\w+)\ndata: (.+)$/gm)].map(m => ({
    event: m[1],
    data: JSON.parse(m[2]),
  }));
}

const marker = `SMOKE${Date.now()}`;
const expiredMarker = `BETA-EXPIRED-${marker}`;
let docId = "";
let expiredId = "";
let keyId = "";
let apiKey = "";
let retrievalId = "";

const POLICY_V1 = [
  "第一章 总则",
  "第一条 为规范员工休假管理，制定本办法。",
  "第二章 休假",
  "第二条 员工工龄满一年的，享受年休假五天。",
  "第三条 年休假不得跨年累积，未休完的部分作废。",
].join("\n");

const POLICY_V2 = POLICY_V1.replace("年休假五天", "年休假十天");

try {
  // ── 1. Health ───────────────────────────────────────────────────────
  console.log("\n1. Health");
  const health = await req("/api/health");
  ok("health returns 200", health.status === 200, `status ${health.status}`);
  ok("Postgres connected", health.body.pgConnected === true);
  ok("embedding endpoint reachable", health.body.ollamaConnected === true);

  // ── 2. Create a clause-structured policy (SSE) ──────────────────────
  console.log("\n2. Create clause-structured policy");
  const events = await sse("/api/sources", {
    name: `smoke-policy-${marker}`,
    type: "Text Document",
    content: POLICY_V1,
  }, USER);

  const start = events.find(e => e.event === "start");
  const done = events.find(e => e.event === "done");
  const error = events.find(e => e.event === "error");
  docId = start?.data?.doc?.id ?? "";
  ok("stream emitted done (no error)", !!done, error ? String(error.data.message) : "no done event");
  ok("document id present", typeof docId === "string" && docId.length > 0);

  const patch = await req(`/api/sources/${docId}`, {
    method: "PATCH", userId: USER,
    body: { kind: "policy", docNo: DOC_NO, effectiveFrom: "2020-01-01" },
  });
  ok("metadata patch accepted", patch.status === 200, `status ${patch.status}`);
  ok("version number is exposed", patch.body.versionNo === 1, `versionNo=${patch.body.versionNo}`);

  // ── 3. Retrieval with clause-level citations ────────────────────────
  console.log("\n3. Citations");
  const r1 = await req("/api/retrieve", {
    method: "POST", userId: USER, body: { query: "年休假可以休几天", topK: 5 },
  });
  ok("retrieve returns 200", r1.status === 200);
  ok("retrievalId is returned", typeof r1.body.retrievalId === "string" && r1.body.retrievalId.startsWith("rtv-"));
  ok("status is hit or weak", ["hit", "weak"].includes(r1.body.status), `status=${r1.body.status}`);
  retrievalId = r1.body.retrievalId ?? "";

  const citations = r1.body.citations ?? [];
  ok("citations are non-empty", citations.length > 0);
  ok("citation carries document identity",
    citations.every(c => c.docId && c.title && typeof c.versionNo === "number"));
  ok("citation carries a clause number", citations.some(c => !!c.clauseNo),
    citations.map(c => c.clauseNo).join(","));
  ok("citation carries a clause path", citations.some(c => (c.clausePath ?? "").includes("第二章")),
    citations[0]?.clausePath ?? "none");
  ok("context uses citation markers", (r1.body.context ?? "").includes("[c1]"));
  ok("diagnostics report both channels", typeof r1.body.diagnostics?.vectorHits === "number"
    && typeof r1.body.diagnostics?.returned === "number");

  // ── 4. Lexical channel: exact doc number ────────────────────────────
  console.log("\n4. Lexical channel");
  const rLex = await req("/api/retrieve", {
    method: "POST", userId: USER, body: { query: DOC_NO, topK: 3 },
  });
  ok("doc number is detected as a lexical key",
    (rLex.body.diagnostics?.lexicalKeys ?? []).includes(DOC_NO),
    JSON.stringify(rLex.body.diagnostics?.lexicalKeys));
  ok("doc number retrieves the document",
    (rLex.body.citations ?? []).some(c => c.docId === docId));

  // ── 5. Agent key + read before write ────────────────────────────────
  console.log("\n5. Agent read");
  const keyRes = await req("/api/agent/keys", {
    method: "POST", userId: USER, body: { label: `smoke-key-${marker}`, rateLimit: 0, sourceFilter: [] },
  });
  ok("agent key created", keyRes.status === 201, `status ${keyRes.status}`);
  keyId = keyRes.body.id ?? "";
  apiKey = keyRes.body.key ?? "";

  if (apiKey) {
    const detail = await req(`/api/agent/sources/${docId}`, { apiKey });
    ok("agent can read the document", detail.status === 200, `status ${detail.status}`);
    ok("detail exposes the current version", detail.body.versionNo === 1, `versionNo=${detail.body.versionNo}`);
    ok("detail exposes kind/docNo", detail.body.kind === "policy" && detail.body.docNo === DOC_NO);
    ok("detail exposes content for read-modify-write", detail.body.content === POLICY_V1);

    // ── 6. Controlled upsert ──────────────────────────────────────────
    console.log("\n6. Controlled upsert");
    const noVersion = await req("/api/agent/sources", {
      method: "POST", apiKey, body: { id: docId, content: POLICY_V2 },
    });
    ok("update without expectedVersion → 409", noVersion.status === 409, `status ${noVersion.status}`);
    ok("409 reports the current version", noVersion.body.currentVersion === 1);

    const stale = await req("/api/agent/sources", {
      method: "POST", apiKey, body: { id: docId, content: POLICY_V2, expectedVersion: 99 },
    });
    ok("stale expectedVersion → 409", stale.status === 409, `status ${stale.status}`);

    const updated = await req("/api/agent/sources", {
      method: "POST", apiKey,
      body: {
        id: docId, content: POLICY_V2, expectedVersion: 1,
        kind: "policy", docNo: DOC_NO, effectiveFrom: "2025-01-01",
      },
    });
    ok("matching expectedVersion → 200 with version 2",
      updated.status === 200 && updated.body.versionNo === 2,
      `status ${updated.status} versionNo=${updated.body.versionNo}`);

    const after = await req("/api/retrieve", {
      method: "POST", userId: USER, body: { query: "年休假", topK: 5 },
    });
    ok("new content is served", (after.body.chunks ?? []).some(c => c.text.includes("十天")));
    ok("old content is no longer served", !(after.body.chunks ?? []).some(c => c.text.includes("五天")));

    // ── 7. As-of retrieval ────────────────────────────────────────────
    console.log("\n7. As-of retrieval");
    const past = await req("/api/retrieve", {
      method: "POST", userId: USER,
      body: { query: "年休假", topK: 5, asOf: "2021-06-01T00:00:00.000Z" },
    });
    ok("as-of returns the version effective in 2021",
      (past.body.chunks ?? []).some(c => c.text.includes("五天")),
      `status=${past.body.status}`);
    ok("as-of does not return the later version",
      !(past.body.chunks ?? []).some(c => c.text.includes("十天")));

    // ── 8. Expiry semantics ───────────────────────────────────────────
    console.log("\n8. Expiry");
    expiredId = `mem-${expiredMarker}`;
    const expired = await req("/api/agent/sources", {
      method: "POST", apiKey,
      body: {
        id: expiredId,
        name: `expired-contract-${marker}`,
        content: `合同 ${expiredMarker} 约定违约金为合同总额的百分之二十。`,
        kind: "contract",
        docNo: `HT-${marker}`,
        effectiveFrom: "2020-01-01",
        effectiveTo: "2020-12-31",
      },
    });
    ok("expired contract created", expired.status === 201, `status ${expired.status} ${expired.body.error ?? ""}`);

    const hidden = await req("/api/retrieve", {
      method: "POST", userId: USER, body: { query: expiredMarker, topK: 5 },
    });
    ok("expired document is excluded by default",
      !(hidden.body.chunks ?? []).some(c => c.sourceId === expiredId),
      `status=${hidden.body.status}`);

    const shown = await req("/api/retrieve", {
      method: "POST", userId: USER,
      body: { query: expiredMarker, topK: 5, includeExpired: true },
    });
    ok("includeExpired surfaces it",
      (shown.body.chunks ?? []).some(c => c.sourceId === expiredId));

    const onlyContracts = await req("/api/retrieve", {
      method: "POST", userId: USER,
      body: { query: expiredMarker, topK: 5, includeExpired: true, kinds: ["contract"] },
    });
    ok("kind filter keeps contracts",
      (onlyContracts.body.citations ?? []).some(c => c.docId === expiredId && c.kind === "contract"));

    const onlyPolicies = await req("/api/retrieve", {
      method: "POST", userId: USER,
      body: { query: expiredMarker, topK: 5, includeExpired: true, kinds: ["policy"] },
    });
    ok("kind filter excludes other kinds",
      !(onlyPolicies.body.citations ?? []).some(c => c.docId === expiredId));

    // ── 9. Feedback loop ──────────────────────────────────────────────
    console.log("\n9. Feedback");
    await sleep(200); // query log insert is fire-and-forget
    const feedback = await req("/api/agent/feedback", {
      method: "POST", apiKey,
      body: {
        retrievalId,
        usedCitationIds: citations.slice(0, 1).map(c => c.citationId),
        verdict: "grounded",
        missingInfo: null,
      },
    });
    ok("feedback accepted", feedback.status === 201, `status ${feedback.status} ${feedback.body.error ?? ""}`);

    const unknown = await req("/api/agent/feedback", {
      method: "POST", apiKey,
      body: { retrievalId: "rtv-does-not-exist", verdict: "grounded" },
    });
    ok("unknown retrievalId → 404", unknown.status === 404, `status ${unknown.status}`);

    const badVerdict = await req("/api/agent/feedback", {
      method: "POST", apiKey, body: { retrievalId, verdict: "nonsense" },
    });
    ok("invalid verdict → 400", badVerdict.status === 400, `status ${badVerdict.status}`);

    // ── 10. Re-index keeps the version chain ──────────────────────────
    console.log("\n10. Re-index");
    const reindex = await sse(`/api/sources/${docId}/reindex`, {}, USER);
    ok("reindex completes", reindex.some(e => e.event === "done"),
      reindex.find(e => e.event === "error")?.data?.message ?? "no done event");
    const afterReindex = await req(`/api/agent/sources/${docId}`, { apiKey });
    ok("reindex advances the version", afterReindex.body.versionNo === 3,
      `versionNo=${afterReindex.body.versionNo}`);
    ok("reindex preserves validity dates",
      (afterReindex.body.effectiveFrom ?? "").startsWith("2025-01-01"),
      afterReindex.body.effectiveFrom ?? "null");
    const stillThere = await req("/api/retrieve", {
      method: "POST", userId: USER, body: { query: "年休假", topK: 5 },
    });
    ok("document stays searchable after reindex",
      (stillThere.body.chunks ?? []).some(c => c.sourceId === docId));
  }
} finally {
  // ── Cleanup ────────────────────────────────────────────────────────
  console.log("\n11. Cleanup");
  if (expiredId) {
    const del = await req(`/api/sources/${expiredId}`, { method: "DELETE", userId: USER });
    ok("delete expired contract", del.status === 200, `status ${del.status}`);
  }
  if (docId) {
    const del = await req(`/api/sources/${docId}`, { method: "DELETE", userId: USER });
    ok("delete policy", del.status === 200, `status ${del.status}`);
  }
  if (keyId) {
    const revoke = await req(`/api/agent/keys/${keyId}`, { method: "DELETE", userId: USER });
    ok("revoke agent key", revoke.status === 200, `status ${revoke.status}`);
  }
}

console.log(`\nResult: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
