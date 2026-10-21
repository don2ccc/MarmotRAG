/**
 * End-to-end verification of the versioned shadow build (T1 + T3).
 *
 * Uses a local fake Ollama-compatible embedding server, so no real model is
 * needed and the vectors are deterministic. Requires Postgres (same env as the
 * app, loaded from .env) and writes only to one throw-away document id.
 *
 *   npm run test:shadow
 *
 * Checks:
 *   1. a committed version is searchable and recorded as `active`
 *   2. chunks of an in-flight version are NOT searchable; the old version still is
 *   3. committing switches atomically, supersedes the old version and drops its chunks
 *   4. aborting a version keeps the previous one searchable and records the failure
 *   5. an embedding failure leaves the previous version searchable
 */
import "dotenv/config";
import http from "node:http";

const DIM = Number(process.env.EMBED_STORE_DIM || 2000);
const DOC_ID = `itest-shadow-${Date.now()}`;
const OWNER_ID = "u-shadow-test";

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

/** Deterministic bag-of-characters embedding: identical text → identical vector. */
function embed(text) {
  const v = new Float64Array(DIM);
  for (const ch of String(text)) {
    v[ch.codePointAt(0) % DIM] += 1;
  }
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  return Array.from(v, x => x / norm);
}

function startEmbedServer(port = 0) {
  const server = http.createServer((req, res) => {
    if (req.url === "/api/tags") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"models":[]}');
      return;
    }
    if (req.url === "/api/embeddings" && req.method === "POST") {
      let body = "";
      req.on("data", c => { body += c; });
      req.on("end", () => {
        let prompt = "";
        try { prompt = JSON.parse(body).prompt ?? ""; } catch { /* ignore */ }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ embedding: embed(prompt) }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise(resolve => {
    server.listen(port, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

async function useEmbedServer() {
  const { server, port } = await startEmbedServer();
  process.env.EMBED_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.EMBED_API = "ollama";
  return server;
}

const V1 = "第一版 ALPHA：违约金为合同总额的百分之十。";
const V2 = "第二版 BETA：违约金为合同总额的百分之二十。";
const V3 = "第三版 GAMMA：违约金为合同总额的百分之三十。";

const db = await import("../.tmp-build/db.js");
const { indexSource } = await import("../.tmp-build/indexing.js");

async function search(text) {
  const rows = await db.searchChunks(embed(text), 10, { userId: OWNER_ID });
  return rows.map(r => r.text);
}

/** Insert a one-chunk version directly, bypassing the embedding pipeline. */
async function stageVersion(text) {
  const versionId = await db.beginVersion(DOC_ID, {
    contentSha256: db.sha256(text),
    strategyHash: "test-strategy",
    embeddingModel: "fake-embedding",
    embeddingDim: DIM,
  });
  await db.insertChunkRows(versionId, [{
    id: `${DOC_ID}::${versionId}::0`,
    sourceId: DOC_ID,
    sourceName: "影子构建测试",
    ordinal: 0,
    text,
    tokensCount: 10,
    charStart: 0,
    charEnd: text.length,
    contentSha256: db.sha256(text),
    embedInputChars: text.length,
    embedding: embed(text),
  }]);
  return versionId;
}

let embedServer = await useEmbedServer();

try {
  await db.initDb();

  // ── 0. Create the document row (not searchable until a version commits) ──
  await db.upsertSource({
    id: DOC_ID, name: "影子构建测试", type: "Text Document", status: "Syncing...",
    lastSync: "", vectorsCount: 0, owner: "shadow-test", ownerAvatar: "",
    ownerId: OWNER_ID, isShared: false, content: V1,
  });

  // ── 1. Committed version is searchable and recorded ──────────────────
  console.log("\n1. Commit");
  const r1 = await indexSource({
    sourceId: DOC_ID, sourceName: "影子构建测试", content: V1,
    chunkSize: 80, chunkOverlapPercent: 0, strategy: "Semantic",
  });
  ok("build produced chunks", r1.chunkCount > 0, `chunkCount=${r1.chunkCount}`);
  let versions = await db.listVersions(DOC_ID);
  ok("one version recorded", versions.length === 1, `got ${versions.length}`);
  ok("version is active", versions[0]?.state === "active", `state=${versions[0]?.state}`);
  ok("version stores the content fingerprint", (versions[0]?.contentSha256 ?? "").length === 64);
  ok("version stores embedding metadata", versions[0]?.embeddingDim === DIM && versions[0]?.embeddingModel.length > 0);
  let texts = await search("ALPHA");
  ok("v1 is searchable", texts.some(t => t.includes("ALPHA")));

  // ── 2. In-flight version is invisible ───────────────────────────────
  console.log("\n2. Shadow version isolation");
  const versionB = await stageVersion(V2);
  ok("in-flight version is marked building",
    (await db.listVersions(DOC_ID)).find(v => v.id === versionB)?.state === "building");
  ok("document reports a build in flight", await db.isVersionBuilding(DOC_ID));
  texts = await search("BETA");
  ok("uncommitted version is NOT searchable", !texts.some(t => t.includes("BETA")));
  ok("previous version still searchable during rebuild", texts.some(t => t.includes("ALPHA")));

  // ── 3. Commit switches atomically ───────────────────────────────────
  console.log("\n3. Switch");
  await db.commitVersion({ docId: DOC_ID, versionId: versionB, chunkCount: 1 });
  texts = await search("BETA");
  ok("v2 is searchable after commit", texts.some(t => t.includes("BETA")));
  ok("v1 chunks were removed", !texts.some(t => t.includes("ALPHA")));
  versions = await db.listVersions(DOC_ID);
  ok("v1 is superseded", versions.find(v => v.versionNo === 1)?.state === "superseded",
    `state=${versions.find(v => v.versionNo === 1)?.state}`);
  ok("v2 is active", versions.find(v => v.versionNo === 2)?.state === "active");
  ok("version numbers increment", versions.map(v => v.versionNo).join(",") === "1,2");
  const doc = (await db.loadVersionStates()).find(s => s.id === DOC_ID);
  ok("document points at v2", doc?.currentVersionId === versionB);
  ok("document reports 2 versions", doc?.versionCount === 2);

  // ── 4. Abort keeps the previous version ─────────────────────────────
  console.log("\n4. Abort");
  const versionC = await stageVersion(V3);
  await db.abortVersion(DOC_ID, versionC, "simulated failure");
  texts = await search("GAMMA");
  ok("aborted version is not searchable", !texts.some(t => t.includes("GAMMA")));
  ok("previous version survives an abort", texts.some(t => t.includes("BETA")));
  const failedVersion = (await db.listVersions(DOC_ID)).find(v => v.id === versionC);
  ok("aborted version is recorded as failed", failedVersion?.state === "failed", `state=${failedVersion?.state}`);
  ok("failure reason is recorded", (failedVersion?.lastError ?? "").includes("simulated"));
  ok("no build is left running", !(await db.isVersionBuilding(DOC_ID)));

  // ── 5. Embedding failure keeps the previous version ─────────────────
  console.log("\n5. Embedding outage");
  embedServer.close();
  await new Promise(r => embedServer.once("close", r));
  process.env.EMBED_BASE_URL = "http://127.0.0.1:9"; // discard port: nothing listens

  let threw = false;
  try {
    await indexSource({
      sourceId: DOC_ID, sourceName: "影子构建测试", content: V3,
      chunkSize: 80, chunkOverlapPercent: 0, strategy: "Semantic",
    });
  } catch {
    threw = true;
  }
  ok("rebuild throws when embeddings are unavailable", threw);
  texts = await search("BETA");
  ok("knowledge survives the failed rebuild", texts.some(t => t.includes("BETA")));
  ok("failed rebuild left no partial chunks", !texts.some(t => t.includes("GAMMA")));

  const afterFailure = (await db.listVersions(DOC_ID)).filter(v => v.state === "failed");
  ok("failed attempt recorded as a version", afterFailure.length === 2, `failed=${afterFailure.length}`);
  const stillDoc = (await db.loadVersionStates()).find(s => s.id === DOC_ID);
  ok("document still serves its active version", stillDoc?.currentVersionId === versionB);
} finally {
  // ── Cleanup ─────────────────────────────────────────────────────────
  try {
    await db.deleteChunksBySource(DOC_ID);
    await db.deleteSource(DOC_ID);
    console.log("\nCleaned up test document.");
  } catch (err) {
    console.error("cleanup failed:", err);
  }
  try { embedServer.close(); } catch { /* already closed */ }
  await db.closePool().catch(() => {});
}

console.log(`\nResult: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
