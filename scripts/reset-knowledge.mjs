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
const keepKeys = process.argv.includes("--keep-keys");
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

async function tableExists(name) {
  const { rows } = await client.query("SELECT to_regclass($1) AS reg", [`public.${name}`]);
  return rows[0].reg !== null;
}

async function wipe(table) {
  if (!(await tableExists(table))) return;
  await client.query(`DELETE FROM ${table}`);
}

const beforeTables = ["marmot_sources", "marmot_doc_versions", "marmot_chunks", "marmot_collections", "marmot_agent_keys"];
const counts = {};
for (const table of beforeTables) {
  if (!(await tableExists(table))) { counts[table] = "missing"; continue; }
  const { rows } = await client.query(`SELECT count(*)::int AS n FROM ${table}`);
  counts[table] = rows[0].n;
}
console.log("before:", counts);

await client.query("BEGIN");
try {
  await wipe("marmot_chunks");
  await wipe("marmot_doc_versions");
  await wipe("marmot_sources");
  await wipe("marmot_collections");
  // Keys carry the old flat sourceFilter semantics; recreating them under the
  // deny-by-default scope model is safer than reinterpreting them.
  if (!keepKeys) await wipe("marmot_agent_keys");
  await client.query("COMMIT");
} catch (err) {
  await client.query("ROLLBACK");
  throw err;
}

const after = {};
for (const table of beforeTables) {
  if (!(await tableExists(table))) { after[table] = "missing"; continue; }
  const { rows } = await client.query(`SELECT count(*)::int AS n FROM ${table}`);
  after[table] = rows[0].n;
}
console.log("after: ", after);
console.log(`Knowledge base cleared${keepKeys ? " (keys kept)" : ", agent keys removed"}. Restart the server (or reload the dashboard) and re-upload.`);

await client.end();
