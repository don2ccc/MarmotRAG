/**
 * HTTP verification of collection + API-key scope enforcement.
 *
 *   npm run serve:fake-embed
 *   npm run build:test && node .tmp-server/server.js
 *   node scripts/verify-scope.mjs http://127.0.0.1:3999
 */
const BASE = process.argv[2] ?? "http://127.0.0.1:3999";
let ADMIN_TOKEN = process.env.ADMIN_TOKEN?.trim();
let passed = 0;
let failed = 0;

async function login() {
  if (ADMIN_TOKEN) return;
  const email = process.env.ADMIN_EMAIL ?? "";
  const password = process.env.ADMIN_PASSWORD ?? "";
  if (!email || !password) throw new Error("Set ADMIN_EMAIL and ADMIN_PASSWORD (or ADMIN_TOKEN) to run this script.");
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`login failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  ADMIN_TOKEN = data.token;
}

await login();

function ok(label, condition, detail = "") {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}${detail ? " — " + detail : ""}`); failed++; }
}

function adminHeaders(headers) {
  if (ADMIN_TOKEN) headers["Authorization"] = `Bearer ${ADMIN_TOKEN}`;
  return headers;
}

async function req(path, { method = "GET", body, apiKey } = {}) {
  const headers = adminHeaders({});
  if (apiKey) headers["X-API-Key"] = apiKey;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${BASE}${path}`, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = {};
  try { json = JSON.parse(text); } catch { /* SSE */ }
  return { status: res.status, body: json, text };
}

async function sse(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: adminHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} → ${res.status} ${await res.text()}`);
  const text = await res.text();
  return [...text.matchAll(/^event: (\w+)\ndata: (.+)$/gm)].map(m => ({ event: m[1], data: JSON.parse(m[2]) }));
}

const marker = `SCOPE${Date.now()}`;
const keys = [];
let collectionId = "";
const docs = [];

try {
  console.log("\n1. Collection");
  const created = await req("/api/collections", {
    method: "POST", body: { name: `HR 制度 ${marker}`, defaultKind: "policy" },
  });
  ok("collection created", created.status === 201, `status ${created.status}`);
  collectionId = created.body.id ?? "";

  console.log("\n2. Documents");
  const policyText = `第一章 总则\n第一条 ${marker} 年休假为十天。`;
  const policy = await sse("/api/sources", { name: `policy-${marker}`, content: policyText });
  const policyId = policy.find(e => e.event === "start")?.data?.doc?.id ?? "";
  docs.push(policyId);
  await req(`/api/sources/${policyId}`, {
    method: "PATCH", body: { kind: "policy", collectionId },
  });

  const contractText = `合同 ${marker} 违约金为合同总额的百分之二十。`;
  const contract = await sse("/api/sources", { name: `contract-${marker}`, content: contractText });
  const contractId = contract.find(e => e.event === "start")?.data?.doc?.id ?? "";
  docs.push(contractId);
  await req(`/api/sources/${contractId}`, { method: "PATCH", body: { kind: "contract" } });

  console.log("\n3. Key scoped to the HR collection");
  const scoped = await req("/api/agent/keys", {
    method: "POST",
    body: {
      label: `hr-key-${marker}`,
      scope: {
        all: false, collections: [collectionId], kinds: [], tags: [], docIds: [],
        allowDraft: false, allowExpired: false, allowAsOf: false,
      },
      rateLimit: 0,
    },
  });
  ok("scoped key created", scoped.status === 201, `status ${scoped.status}`);
  keys.push(scoped.body.id);

  const scopedRetrieve = await req("/api/agent/retrieve", {
    method: "POST", apiKey: scoped.body.key, body: { query: marker, topK: 10 },
  });
  const scopedIds = (scopedRetrieve.body.chunks ?? []).map(c => c.sourceId);
  ok("scoped key sees the collection document", scopedIds.includes(policyId));
  ok("scoped key cannot see a document outside the collection", !scopedIds.includes(contractId));

  console.log("\n4. Empty scope denies everything");
  const empty = await req("/api/agent/keys", {
    method: "POST",
    body: {
      label: `empty-key-${marker}`,
      scope: {
        all: false, collections: [], kinds: [], tags: [], docIds: [],
        allowDraft: false, allowExpired: false, allowAsOf: false,
      },
      rateLimit: 0,
    },
  });
  keys.push(empty.body.id);
  const emptyRetrieve = await req("/api/agent/retrieve", {
    method: "POST", apiKey: empty.body.key, body: { query: marker, topK: 10 },
  });
  ok("empty scope returns nothing", (emptyRetrieve.body.chunks ?? []).length === 0,
    `returned ${(emptyRetrieve.body.chunks ?? []).length}`);
  ok("empty scope reports status empty", emptyRetrieve.body.status === "empty",
    `status=${emptyRetrieve.body.status}`);

  console.log("\n5. Caller cannot widen its own scope");
  const widened = await req("/api/agent/retrieve", {
    method: "POST", apiKey: scoped.body.key,
    body: { query: marker, topK: 10, docIds: [contractId] },
  });
  ok("requesting an out-of-scope document returns nothing",
    (widened.body.chunks ?? []).every(c => c.sourceId !== contractId));

  console.log("\n6. Full-scope key sees both");
  const full = await req("/api/agent/keys", {
    method: "POST",
    body: {
      label: `full-key-${marker}`,
      scope: {
        all: true, collections: [], kinds: [], tags: [], docIds: [],
        allowDraft: false, allowExpired: false, allowAsOf: false,
      },
      rateLimit: 0,
    },
  });
  keys.push(full.body.id);
  const fullRetrieve = await req("/api/agent/retrieve", {
    method: "POST", apiKey: full.body.key, body: { query: marker, topK: 10 },
  });
  const fullIds = (fullRetrieve.body.chunks ?? []).map(c => c.sourceId);
  ok("full-scope key sees the policy", fullIds.includes(policyId));
  ok("full-scope key sees the contract", fullIds.includes(contractId));

  console.log("\n7. Versions endpoint");
  const versions = await req(`/api/sources/${policyId}/versions`);
  ok("version history is returned", versions.status === 200 && Array.isArray(versions.body.versions));
  ok("current version is active", versions.body.versions?.[0]?.state === "active");
} finally {
  console.log("\n8. Cleanup");
  for (const id of docs) await req(`/api/sources/${id}`, { method: "DELETE" });
  for (const id of keys) await req(`/api/agent/keys/${id}`, { method: "DELETE" });
  if (collectionId) await req(`/api/collections/${collectionId}`, { method: "DELETE" });
  console.log("  cleaned up");
}

console.log(`\nResult: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
