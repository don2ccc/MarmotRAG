import pg from "pg";
import pgvector from "pgvector/pg";

const { Pool } = pg;

// Strip surrounding quotes that some dotenv tools preserve (e.g. "dongdong" → dongdong)
function pgEnv(key: string, fallback: string): string {
  const val = process.env[key] ?? fallback;
  return val.replace(/^["']|["']$/g, "");
}

// Lazy pool — created on first use so that process.env is already populated by dotenv
let _pool: pg.Pool | null = null;

function getPool(): pg.Pool {
  if (!_pool) {
    _pool = new Pool({
      host:     pgEnv("PG_HOST",     "127.0.0.1"),
      port:     Number(pgEnv("PG_PORT", "5432")),
      user:     pgEnv("PG_USER",     "postgres"),
      password: pgEnv("PG_PASSWORD", ""),
      database: pgEnv("PG_DATABASE", "ai_hub"),
    });

    _pool.on("connect", async (client) => {
      await pgvector.registerTypes(client);
    });
  }
  return _pool;
}

/**
 * Create the pgvector extension (if needed) and the marmot_chunks table.
 * Called once at server startup (after dotenv has loaded).
 *
 * Table: marmot_chunks
 *   id          – stable chunk identifier  (e.g. "src-1-chk-0")
 *   source_id   – parent SourceDoc id
 *   source_name – human-readable source name
 *   text        – raw chunk text
 *   tokens_count– approximate word count
 *   embedding   – 768-dim vector (nomic-embed-text)
 */
export async function initDb(): Promise<void> {
  const pool = getPool();
  // Run each DDL statement with its own pool.query() call to avoid
  // the "client already executing" deprecation warning from pg-pool.
  await pool.query("CREATE EXTENSION IF NOT EXISTS vector");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS marmot_chunks (
      id           TEXT PRIMARY KEY,
      source_id    TEXT NOT NULL,
      source_name  TEXT NOT NULL,
      text         TEXT NOT NULL,
      tokens_count INTEGER NOT NULL DEFAULT 0,
      embedding    vector(768)
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS marmot_chunks_embedding_idx
    ON marmot_chunks
    USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 10)
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS marmot_sources (
      id           TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      type         TEXT NOT NULL DEFAULT 'Text Document',
      status       TEXT NOT NULL DEFAULT 'Synced',
      last_sync    TEXT NOT NULL DEFAULT '',
      vectors_count INTEGER NOT NULL DEFAULT 0,
      owner        TEXT NOT NULL DEFAULT 'You',
      owner_avatar TEXT NOT NULL DEFAULT '',
      content      TEXT NOT NULL DEFAULT ''
    )
  `);
  console.log("[db] marmot_chunks + marmot_sources tables ready");
}

/** Strip characters PostgreSQL UTF-8 encoder rejects (null bytes, stray control chars). */
function sanitizeText(s: string): string {
  return s.replace(/\x00/g, "").replace(/[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]/g, " ").trim();
}

/** Upsert a single chunk (insert or replace on duplicate id). */
export async function upsertChunk(chunk: {
  id: string;
  sourceId: string;
  sourceName: string;
  text: string;
  tokensCount: number;
  embedding: number[];
}): Promise<void> {
  const safeText = sanitizeText(chunk.text);
  await getPool().query(
    `INSERT INTO marmot_chunks (id, source_id, source_name, text, tokens_count, embedding)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (id) DO UPDATE
       SET source_name  = EXCLUDED.source_name,
           text         = EXCLUDED.text,
           tokens_count = EXCLUDED.tokens_count,
           embedding    = EXCLUDED.embedding`,
    [chunk.id, chunk.sourceId, chunk.sourceName, safeText, chunk.tokensCount,
     pgvector.toSql(chunk.embedding)]
  );
}

/** Delete all chunks belonging to a source document. */
export async function deleteChunksBySource(sourceId: string): Promise<void> {
  await getPool().query(
    "DELETE FROM marmot_chunks WHERE source_id = $1",
    [sourceId]
  );
}

/** Return the top-k chunks nearest to the query embedding, skipping given source ids. */
export async function searchChunks(
  queryEmbedding: number[],
  topK: number,
  excludeSourceIds: string[] = []
): Promise<{ id: string; sourceId: string; sourceName: string; text: string; tokensCount: number; score: number }[]> {
  const excludeClause = excludeSourceIds.length > 0
    ? `AND source_id <> ALL($2::text[])`
    : "";

  const params: unknown[] = [pgvector.toSql(queryEmbedding)];
  if (excludeSourceIds.length > 0) params.push(excludeSourceIds);
  params.push(topK);

  const { rows } = await getPool().query(
    `SELECT id, source_id, source_name, text, tokens_count,
            1 - (embedding <=> $1) AS score
     FROM marmot_chunks
     WHERE embedding IS NOT NULL
     ${excludeClause}
     ORDER BY embedding <=> $1
     LIMIT $${params.length}`,
    params
  );

  return rows.map((r) => ({
    id: r.id,
    sourceId: r.source_id,
    sourceName: r.source_name,
    text: r.text,
    tokensCount: r.tokens_count,
    score: parseFloat(r.score),
  }));
}

// ── Sources persistence ────────────────────────────────────────────────────

export interface PersistedSource {
  id: string;
  name: string;
  type: string;
  status: string;
  lastSync: string;
  vectorsCount: number;
  owner: string;
  ownerAvatar: string;
  content: string;
}

/** Load all source documents from the DB (called at startup). */
export async function loadSources(): Promise<PersistedSource[]> {
  const { rows } = await getPool().query(
    `SELECT id, name, type, status, last_sync, vectors_count, owner, owner_avatar, content
     FROM marmot_sources
     ORDER BY id`
  );
  return rows.map(r => ({
    id: r.id,
    name: r.name,
    type: r.type,
    status: r.status,
    lastSync: r.last_sync,
    vectorsCount: r.vectors_count,
    owner: r.owner,
    ownerAvatar: r.owner_avatar,
    content: r.content,
  }));
}

/** Count how many source rows exist (used for seed guard). */
export async function countSources(): Promise<number> {
  const { rows } = await getPool().query("SELECT COUNT(*)::int AS n FROM marmot_sources");
  return rows[0].n;
}

/** Insert or update a source document record. */
export async function upsertSource(s: PersistedSource): Promise<void> {
  await getPool().query(
    `INSERT INTO marmot_sources (id, name, type, status, last_sync, vectors_count, owner, owner_avatar, content)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (id) DO UPDATE
       SET name          = EXCLUDED.name,
           type          = EXCLUDED.type,
           status        = EXCLUDED.status,
           last_sync     = EXCLUDED.last_sync,
           vectors_count = EXCLUDED.vectors_count,
           owner         = EXCLUDED.owner,
           owner_avatar  = EXCLUDED.owner_avatar,
           content       = EXCLUDED.content`,
    [s.id, s.name, s.type, s.status, s.lastSync, s.vectorsCount, s.owner, s.ownerAvatar, sanitizeText(s.content)]
  );
}

/** Delete a source document record. */
export async function deleteSource(id: string): Promise<void> {
  await getPool().query("DELETE FROM marmot_sources WHERE id = $1", [id]);
}
