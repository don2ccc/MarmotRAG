/**
 * Read-only diagnostics for the MarmotRAG index state.
 *
 *   npm run db:check
 *
 * Prints pgvector version, the stored embedding dimension, and a per-document
 * summary of versions and chunks — the first thing to look at when retrieval
 * returns nothing or a re-index seems stuck.
 */
import "dotenv/config";
import pg from "pg";

const client = new pg.Client({
  host: process.env.PG_HOST || "127.0.0.1",
  port: Number(process.env.PG_PORT || 5432),
  user: process.env.PG_USER || "postgres",
  password: (process.env.PG_PASSWORD || "").replace(/^["']|["']$/g, ""),
  database: process.env.PG_DATABASE || "ai_hub",
});

await client.connect();

const ext = await client.query("SELECT extversion FROM pg_extension WHERE extname = 'vector'");
const typmod = await client.query(`
  SELECT a.atttypmod
    FROM pg_attribute a
    JOIN pg_class k ON k.oid = a.attrelid
   WHERE k.relname = 'marmot_chunks' AND a.attname = 'embedding' AND a.attnum > 0
`);
const totals = await client.query(`
  SELECT count(*)::int AS chunks,
         count(*) FILTER (WHERE embedding IS NULL)::int AS without_vector
    FROM marmot_chunks
`).catch(() => null);
const docs = await client.query(`
  SELECT s.id, s.name, s.status, s.current_version_id, s.vectors_count,
         length(s.content) AS content_chars,
         (SELECT count(*)::int FROM marmot_doc_versions v WHERE v.doc_id = s.id) AS versions,
         (SELECT count(*)::int FROM marmot_chunks c WHERE c.source_id = s.id) AS chunks
    FROM marmot_sources s
   ORDER BY s.id
`).catch(() => null);
const stuck = await client.query(`
  SELECT v.id, v.doc_id, v.version_no, v.state, v.last_error
    FROM marmot_doc_versions v
   WHERE v.state IN ('building', 'failed')
   ORDER BY v.created_at DESC
   LIMIT 20
`).catch(() => null);
const config = await client.query(
  "SELECT value FROM marmot_config WHERE key = 'strategy'"
).catch(() => null);

console.log("pgvector:        ", ext.rows[0]?.extversion ?? "MISSING (CREATE EXTENSION vector)");
console.log("stored dimension:", typmod.rows[0]?.atttypmod ?? "no marmot_chunks.embedding");
console.log("EMBED_STORE_DIM: ", process.env.EMBED_STORE_DIM ?? "2000 (default)");
console.log("chunks:          ", totals?.rows[0]?.chunks ?? "no table",
  `(${totals?.rows[0]?.without_vector ?? 0} without vector)`);
console.log("strategy config: ", config?.rows[0]?.value ?? "none");

if (!docs || docs.rows.length === 0) {
  console.log("\nNo documents.");
} else {
  console.log("\nid                     status     versions  chunks  vectors  content  name");
  for (const row of docs.rows) {
    console.log([
      String(row.id).padEnd(22),
      String(row.status).padEnd(10),
      String(row.versions).padStart(8),
      String(row.chunks).padStart(7),
      String(row.vectors_count).padStart(8),
      String(row.content_chars ?? 0).padStart(8),
      row.name,
    ].join(" "));
  }
  const noVersion = docs.rows.filter(r => !r.current_version_id && Number(r.content_chars) > 0);
  if (noVersion.length) {
    console.log(`\n⚠ ${noVersion.length} document(s) have no servable version — they are rebuilt at next startup.`);
  }
}

if (stuck?.rows.length) {
  console.log("\nVersions needing attention:");
  for (const v of stuck.rows) {
    console.log(`  ${v.state.padEnd(10)} v${v.version_no} ${v.doc_id}${v.last_error ? ` — ${String(v.last_error).slice(0, 70)}` : ""}`);
  }
  if (stuck.rows.some(v => v.state === "building")) {
    console.log("  ⚠ 'building' versions only exist during an active rebuild; if the server is not running they were interrupted.");
  }
}

await client.end();
