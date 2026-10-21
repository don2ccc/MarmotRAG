/**
 * Wipe the knowledge base and start over.
 *
 * Deletes documents, versions and chunks. Keeps users, agent keys, the chunking
 * config and query logs, so the dashboard still works and keys stay valid.
 *
 *   npm run db:reset -- --yes
 *
 * Refuses to run without --yes because it is irreversible.
 */
import "dotenv/config";
import pg from "pg";

const confirmed = process.argv.includes("--yes");
if (!confirmed) {
  console.error("Refusing to delete data without --yes.\nRun: npm run db:reset -- --yes");
  process.exit(1);
}

const client = new pg.Client({
  host: process.env.PG_HOST || "127.0.0.1",
  port: Number(process.env.PG_PORT || 5432),
  user: process.env.PG_USER || "postgres",
  password: (process.env.PG_PASSWORD || "").replace(/^["']|["']$/g, ""),
  database: process.env.PG_DATABASE || "ai_hub",
});

await client.connect();

const before = await client.query(`
  SELECT
    (SELECT count(*)::int FROM marmot_sources)      AS documents,
    (SELECT count(*)::int FROM marmot_doc_versions) AS versions,
    (SELECT count(*)::int FROM marmot_chunks)       AS chunks
`);
console.log("before:", before.rows[0]);

await client.query("BEGIN");
try {
  await client.query("DELETE FROM marmot_chunks");
  await client.query("DELETE FROM marmot_doc_versions");
  await client.query("DELETE FROM marmot_sources");
  await client.query("COMMIT");
} catch (err) {
  await client.query("ROLLBACK");
  throw err;
}

const after = await client.query(`
  SELECT
    (SELECT count(*)::int FROM marmot_sources)      AS documents,
    (SELECT count(*)::int FROM marmot_doc_versions) AS versions,
    (SELECT count(*)::int FROM marmot_chunks)       AS chunks
`);
console.log("after: ", after.rows[0]);
console.log("Knowledge base cleared. Restart the server (or reload the dashboard) and re-upload.");

await client.end();
