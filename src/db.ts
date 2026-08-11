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
 * Create the pgvector extension (if needed) and all marmot_* tables.
 * Called once at server startup. All migrations are idempotent so they are
 * safe to run on every boot.
 */
export async function initDb(): Promise<void> {
  const pool = getPool();
  // Run each DDL statement with its own pool.query() call to avoid
  // the "client already executing" deprecation warning from pg-pool.
  await pool.query("CREATE EXTENSION IF NOT EXISTS vector");
  // Migrate embedding dimension if the table already exists with a different size.
  // Target: vector(2000) — pgvector ivfflat hard limit is 2000 dims.
  const TARGET_TYPMOD = 2008; // vector(2000) = 2000 + 8
  const dimCheck = await pool.query(`
    SELECT atttypmod
    FROM pg_attribute
    JOIN pg_class ON pg_class.oid = pg_attribute.attrelid
    WHERE pg_class.relname = 'marmot_chunks'
      AND pg_attribute.attname = 'embedding'
      AND pg_attribute.attnum > 0
  `);
  if (dimCheck.rows.length > 0 && dimCheck.rows[0].atttypmod !== TARGET_TYPMOD) {
    console.log(`[db] Embedding dimension mismatch (typmod=${dimCheck.rows[0].atttypmod}, want ${TARGET_TYPMOD}), recreating marmot_chunks table...`);
    await pool.query("DROP INDEX IF EXISTS marmot_chunks_embedding_idx");
    await pool.query("DROP TABLE IF EXISTS marmot_chunks");
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS marmot_chunks (
      id           TEXT PRIMARY KEY,
      source_id    TEXT NOT NULL,
      source_name  TEXT NOT NULL,
      text         TEXT NOT NULL,
      tokens_count INTEGER NOT NULL DEFAULT 0,
      embedding    vector(2000)
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS marmot_chunks_embedding_idx
    ON marmot_chunks
    USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64)
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
      owner_id     TEXT NOT NULL DEFAULT '',
      is_shared    BOOLEAN NOT NULL DEFAULT FALSE,
      content      TEXT NOT NULL DEFAULT ''
    )
  `);

  // ── Migrations for existing databases ──────────────────────────────
  await pool.query(`ALTER TABLE marmot_sources ADD COLUMN IF NOT EXISTS owner_id TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE marmot_sources ADD COLUMN IF NOT EXISTS is_shared BOOLEAN NOT NULL DEFAULT FALSE`);
  await pool.query(`UPDATE marmot_sources SET owner_id = 'u-1' WHERE owner_id = ''`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS marmot_config (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS marmot_agent_keys (
      id                TEXT PRIMARY KEY,
      label             TEXT NOT NULL,
      key               TEXT NOT NULL UNIQUE,
      key_preview       TEXT NOT NULL,
      owner_id          TEXT NOT NULL DEFAULT '',
      source_filter     TEXT NOT NULL DEFAULT '[]',
      rate_limit        INTEGER NOT NULL DEFAULT 60,
      enabled           BOOLEAN NOT NULL DEFAULT TRUE,
      created_at        TEXT NOT NULL DEFAULT '',
      last_used_at      TEXT,
      usage_count       INTEGER NOT NULL DEFAULT 0,
      usage_this_month  INTEGER NOT NULL DEFAULT 0,
      month_stamp       TEXT NOT NULL DEFAULT ''
    )
  `);
  await pool.query(`ALTER TABLE marmot_agent_keys ADD COLUMN IF NOT EXISTS owner_id TEXT NOT NULL DEFAULT ''`);
  await pool.query(`UPDATE marmot_agent_keys SET owner_id = 'u-1' WHERE owner_id = ''`);
  await pool.query(`ALTER TABLE marmot_agent_keys DROP COLUMN IF EXISTS pipeline_id`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS marmot_query_logs (
      id               TEXT PRIMARY KEY,
      timestamp        TEXT NOT NULL,
      query            TEXT NOT NULL,
      user_id          TEXT NOT NULL DEFAULT '',
      via              TEXT NOT NULL DEFAULT 'user',
      latency_ms       INTEGER NOT NULL DEFAULT 0,
      status           TEXT NOT NULL DEFAULT 'success',
      retrieved_chunks TEXT NOT NULL DEFAULT '[]'
    )
  `);
  await pool.query(`ALTER TABLE marmot_query_logs ADD COLUMN IF NOT EXISTS user_id TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE marmot_query_logs ADD COLUMN IF NOT EXISTS via TEXT NOT NULL DEFAULT 'user'`);
  await pool.query(`ALTER TABLE marmot_query_logs DROP COLUMN IF EXISTS pipeline`);
  await pool.query(`ALTER TABLE marmot_query_logs DROP COLUMN IF EXISTS answer`);
  await pool.query(`ALTER TABLE marmot_query_logs DROP COLUMN IF EXISTS faithfulness_score`);
  await pool.query(`ALTER TABLE marmot_query_logs DROP COLUMN IF EXISTS relevance_score`);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS marmot_query_logs_ts_idx
    ON marmot_query_logs (timestamp DESC)
  `);

  // Pipelines are removed in the retrieval-only redesign.
  await pool.query(`DROP TABLE IF EXISTS marmot_pipelines`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS marmot_users (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      email      TEXT NOT NULL UNIQUE,
      role       TEXT NOT NULL DEFAULT 'Viewer',
      last_login TEXT NOT NULL DEFAULT ''
    )
  `);
  console.log("[db] All marmot_* tables ready");
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

/**
 * Return the top-k chunks nearest to the query embedding that the given user
 * is allowed to see: own sources (owner_id = userId) or shared sources
 * (is_shared = TRUE) that are Synced.
 */
export async function searchChunks(
  queryEmbedding: number[],
  topK: number,
  opts: { userId: string; sourceFilter?: string[]; excludeSourceIds?: string[] }
): Promise<{ id: string; sourceId: string; sourceName: string; text: string; tokensCount: number; score: number }[]> {
  const { userId, sourceFilter, excludeSourceIds } = opts;
  const conditions = [
    `c.embedding IS NOT NULL`,
    `s.status = 'Synced'`,
    `(s.owner_id = $2 OR s.is_shared = TRUE)`,
  ];
  const params: unknown[] = [pgvector.toSql(queryEmbedding), userId];
  let idx = 3;
  if (sourceFilter && sourceFilter.length > 0) {
    conditions.push(`c.source_id = ANY($${idx}::text[])`);
    params.push(sourceFilter);
    idx++;
  }
  if (excludeSourceIds && excludeSourceIds.length > 0) {
    conditions.push(`c.source_id <> ALL($${idx}::text[])`);
    params.push(excludeSourceIds);
    idx++;
  }
  params.push(topK);

  const { rows } = await getPool().query(
    `SELECT c.id, c.source_id, c.source_name, c.text, c.tokens_count,
            1 - (c.embedding <=> $1) AS score
     FROM marmot_chunks c
     JOIN marmot_sources s ON s.id = c.source_id
     WHERE ${conditions.join(" AND ")}
     ORDER BY c.embedding <=> $1
     LIMIT $${idx}`,
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

// ── Sources persistence ───────────────────────────────────────────────

export interface PersistedSource {
  id: string;
  name: string;
  type: string;
  status: string;
  lastSync: string;
  vectorsCount: number;
  owner: string;
  ownerAvatar: string;
  ownerId: string;
  isShared: boolean;
  content: string;
}

const SOURCE_COLUMNS = `id, name, type, status, last_sync, vectors_count, owner, owner_avatar, owner_id, is_shared, content`;

function mapSource(r: Record<string, unknown>): PersistedSource {
  return {
    id: r.id as string,
    name: r.name as string,
    type: r.type as string,
    status: r.status as string,
    lastSync: r.last_sync as string,
    vectorsCount: r.vectors_count as number,
    owner: r.owner as string,
    ownerAvatar: r.owner_avatar as string,
    ownerId: r.owner_id as string,
    isShared: r.is_shared as boolean,
    content: r.content as string,
  };
}

/** Load all source documents from the DB (called at startup). */
export async function loadSources(): Promise<PersistedSource[]> {
  const { rows } = await getPool().query(
    `SELECT ${SOURCE_COLUMNS} FROM marmot_sources ORDER BY id`
  );
  return rows.map(mapSource);
}

/** Count how many source rows exist (used for seed guard). */
export async function countSources(): Promise<number> {
  const { rows } = await getPool().query("SELECT COUNT(*)::int AS n FROM marmot_sources");
  return rows[0].n;
}

/** Count total chunk rows (used to detect dimension migration requiring full reindex). */
export async function countChunks(): Promise<number> {
  const { rows } = await getPool().query("SELECT COUNT(*)::int AS n FROM marmot_chunks");
  return rows[0].n;
}

/** Insert or update a source document record. */
export async function upsertSource(s: PersistedSource): Promise<void> {
  await getPool().query(
    `INSERT INTO marmot_sources (${SOURCE_COLUMNS})
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (id) DO UPDATE
       SET name          = EXCLUDED.name,
           type          = EXCLUDED.type,
           status        = EXCLUDED.status,
           last_sync     = EXCLUDED.last_sync,
           vectors_count = EXCLUDED.vectors_count,
           owner         = EXCLUDED.owner,
           owner_avatar  = EXCLUDED.owner_avatar,
           owner_id      = EXCLUDED.owner_id,
           is_shared     = EXCLUDED.is_shared,
           content       = EXCLUDED.content`,
    [s.id, s.name, s.type, s.status, s.lastSync, s.vectorsCount, s.owner, s.ownerAvatar,
     s.ownerId, s.isShared, sanitizeText(s.content)]
  );
}

/** Delete a source document record. */
export async function deleteSource(id: string): Promise<void> {
  await getPool().query("DELETE FROM marmot_sources WHERE id = $1", [id]);
}

/** Lightweight connectivity check — just runs SELECT 1. */
export async function pingDb(): Promise<void> {
  await getPool().query("SELECT 1");
}

/** Close the connection pool — called during graceful shutdown. */
export async function closePool(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}

/** Count sources with optional search filter (for server-side KB pagination). */
export async function countSourcesFiltered(search?: string): Promise<number> {
  if (!search) {
    const { rows } = await getPool().query("SELECT COUNT(*)::int AS n FROM marmot_sources");
    return rows[0].n;
  }
  const { rows } = await getPool().query(
    "SELECT COUNT(*)::int AS n FROM marmot_sources WHERE name ILIKE $1 OR type ILIKE $1",
    [`%${search}%`]
  );
  return rows[0].n;
}

/** Load a paginated, optionally filtered list of sources. */
export async function loadSourcesPaginated(opts: {
  limit: number;
  offset: number;
  search?: string;
}): Promise<PersistedSource[]> {
  const { rows } = opts.search
    ? await getPool().query(
        `SELECT ${SOURCE_COLUMNS} FROM marmot_sources
         WHERE name ILIKE $1 OR type ILIKE $1
         ORDER BY id LIMIT $2 OFFSET $3`,
        [`%${opts.search}%`, opts.limit, opts.offset]
      )
    : await getPool().query(
        `SELECT ${SOURCE_COLUMNS} FROM marmot_sources
         ORDER BY id LIMIT $1 OFFSET $2`,
        [opts.limit, opts.offset]
      );
  return rows.map(mapSource);
}

/** Load chunks for a specific source (for chunk-preview feature). */
export async function loadChunksBySource(
  sourceId: string,
  limit = 10
): Promise<{ id: string; text: string; tokensCount: number }[]> {
  const { rows } = await getPool().query(
    `SELECT id, text, tokens_count FROM marmot_chunks
     WHERE source_id = $1
     ORDER BY id
     LIMIT $2`,
    [sourceId, limit]
  );
  return rows.map(r => ({ id: r.id, text: r.text, tokensCount: r.tokens_count }));
}

// ── Config persistence ────────────────────────────────────────────────

/** Load a single JSON config blob stored under key 'strategy'. */
export async function loadConfig(): Promise<Record<string, unknown> | null> {
  const { rows } = await getPool().query(
    "SELECT value FROM marmot_config WHERE key = 'strategy'"
  );
  if (rows.length === 0) return null;
  try { return JSON.parse(rows[0].value); } catch { return null; }
}

/** Persist the strategy config object. */
export async function saveConfig(cfg: Record<string, unknown>): Promise<void> {
  await getPool().query(
    `INSERT INTO marmot_config (key, value) VALUES ('strategy', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [JSON.stringify(cfg)]
  );
}

// ── Agent key persistence ─────────────────────────────────────────────

export interface PersistedAgentKey {
  id: string;
  label: string;
  key: string;
  keyPreview: string;
  ownerId: string;
  sourceFilter: string[];
  rateLimit: number;
  enabled: boolean;
  createdAt: string;
  lastUsedAt: string | null;
  usageCount: number;
  usageThisMonth: number;
  monthStamp: string;
}

export async function loadAgentKeys(): Promise<PersistedAgentKey[]> {
  const { rows } = await getPool().query(
    `SELECT id, label, key, key_preview, owner_id, source_filter, rate_limit,
            enabled, created_at, last_used_at, usage_count, usage_this_month, month_stamp
     FROM marmot_agent_keys
     ORDER BY created_at`
  );
  return rows.map(r => ({
    id: r.id,
    label: r.label,
    key: r.key,
    keyPreview: r.key_preview,
    ownerId: r.owner_id,
    sourceFilter: JSON.parse(r.source_filter ?? "[]"),
    rateLimit: r.rate_limit,
    enabled: r.enabled,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    usageCount: r.usage_count,
    usageThisMonth: r.usage_this_month,
    monthStamp: r.month_stamp,
  }));
}

export async function upsertAgentKey(k: PersistedAgentKey): Promise<void> {
  await getPool().query(
    `INSERT INTO marmot_agent_keys
       (id, label, key, key_preview, owner_id, source_filter, rate_limit, enabled,
        created_at, last_used_at, usage_count, usage_this_month, month_stamp)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (id) DO UPDATE
       SET label             = EXCLUDED.label,
           key               = EXCLUDED.key,
           key_preview       = EXCLUDED.key_preview,
           owner_id          = EXCLUDED.owner_id,
           source_filter     = EXCLUDED.source_filter,
           rate_limit        = EXCLUDED.rate_limit,
           enabled           = EXCLUDED.enabled,
           created_at        = EXCLUDED.created_at,
           last_used_at      = EXCLUDED.last_used_at,
           usage_count       = EXCLUDED.usage_count,
           usage_this_month  = EXCLUDED.usage_this_month,
           month_stamp       = EXCLUDED.month_stamp`,
    [k.id, k.label, k.key, k.keyPreview, k.ownerId, JSON.stringify(k.sourceFilter),
     k.rateLimit, k.enabled, k.createdAt, k.lastUsedAt, k.usageCount, k.usageThisMonth, k.monthStamp]
  );
}

export async function deleteAgentKeyById(id: string): Promise<void> {
  await getPool().query("DELETE FROM marmot_agent_keys WHERE id = $1", [id]);
}

export async function countAgentKeys(): Promise<number> {
  const { rows } = await getPool().query("SELECT COUNT(*)::int AS n FROM marmot_agent_keys");
  return rows[0].n;
}

// ── Query log persistence ─────────────────────────────────────────────
// Max rows retained in DB (prune oldest on insert when exceeded)
const QUERY_LOG_MAX_ROWS = 10_000;

export interface PersistedQueryLog {
  id: string;
  timestamp: string;
  query: string;
  userId: string;
  via: string;
  latencyMs: number;
  status: string;
  retrievedChunks: { chunkId: string; sourceName: string; text: string; score: number }[];
}

export async function loadQueryLogs(limit = 200, userId?: string): Promise<PersistedQueryLog[]> {
  const { rows } = userId
    ? await getPool().query(
        `SELECT id, timestamp, query, user_id, via, latency_ms, status, retrieved_chunks
         FROM marmot_query_logs
         WHERE user_id = $2
         ORDER BY timestamp DESC
         LIMIT $1`,
        [limit, userId]
      )
    : await getPool().query(
        `SELECT id, timestamp, query, user_id, via, latency_ms, status, retrieved_chunks
         FROM marmot_query_logs
         ORDER BY timestamp DESC
         LIMIT $1`,
        [limit]
      );
  return rows.map(r => ({
    id: r.id,
    timestamp: r.timestamp,
    query: r.query,
    userId: r.user_id,
    via: r.via,
    latencyMs: r.latency_ms,
    status: r.status,
    retrievedChunks: JSON.parse(r.retrieved_chunks ?? "[]"),
  }));
}

/** Query logs with optional filters. Returns { rows, total }. */
export async function queryLogsPaginated(opts: {
  limit: number;
  offset: number;
  userId?: string;
  status?: string;
  search?: string;
}): Promise<{ logs: PersistedQueryLog[]; total: number }> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = 1;
  if (opts.userId) { conditions.push(`user_id = $${idx++}`); params.push(opts.userId); }
  if (opts.status) { conditions.push(`status = $${idx++}`); params.push(opts.status); }
  if (opts.search) { conditions.push(`query ILIKE $${idx++}`); params.push(`%${opts.search}%`); }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const countRes = await getPool().query(`SELECT COUNT(*)::int AS n FROM marmot_query_logs ${where}`, params);
  const total = countRes.rows[0].n;
  const rowsRes = await getPool().query(
    `SELECT id, timestamp, query, user_id, via, latency_ms, status, retrieved_chunks
     FROM marmot_query_logs ${where}
     ORDER BY timestamp DESC
     LIMIT $${idx++} OFFSET $${idx++}`,
    [...params, opts.limit, opts.offset]
  );
  const logs = rowsRes.rows.map((r: Record<string, unknown>) => ({
    id: r.id as string,
    timestamp: r.timestamp as string,
    query: r.query as string,
    userId: r.user_id as string,
    via: r.via as string,
    latencyMs: r.latency_ms as number,
    status: r.status as string,
    retrievedChunks: JSON.parse((r.retrieved_chunks as string) ?? "[]"),
  }));
  return { logs, total };
}

export async function insertQueryLog(log: PersistedQueryLog): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO marmot_query_logs
       (id, timestamp, query, user_id, via, latency_ms, status, retrieved_chunks)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (id) DO NOTHING`,
    [log.id, log.timestamp, sanitizeText(log.query), log.userId, log.via,
     log.latencyMs, log.status, JSON.stringify(log.retrievedChunks)]
  );
  // Prune oldest rows beyond the cap
  const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM marmot_query_logs");
  if (rows[0].n > QUERY_LOG_MAX_ROWS) {
    await pool.query(
      `DELETE FROM marmot_query_logs
       WHERE id IN (
         SELECT id FROM marmot_query_logs
         ORDER BY timestamp ASC
         LIMIT $1
       )`,
      [rows[0].n - QUERY_LOG_MAX_ROWS]
    );
  }
}

// ── User persistence ──────────────────────────────────────────────────

export interface PersistedUser {
  id: string;
  name: string;
  email: string;
  role: string;
  lastLogin: string;
}

export async function loadUsers(): Promise<PersistedUser[]> {
  const { rows } = await getPool().query(
    "SELECT id, name, email, role, last_login FROM marmot_users ORDER BY id"
  );
  return rows.map(r => ({
    id: r.id,
    name: r.name,
    email: r.email,
    role: r.role,
    lastLogin: r.last_login,
  }));
}

export async function upsertUser(u: PersistedUser): Promise<void> {
  await getPool().query(
    `INSERT INTO marmot_users (id, name, email, role, last_login)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (id) DO UPDATE
       SET name       = EXCLUDED.name,
           email      = EXCLUDED.email,
           role       = EXCLUDED.role,
           last_login = EXCLUDED.last_login`,
    [u.id, u.name, u.email, u.role, u.lastLogin]
  );
}

export async function deleteUserById(id: string): Promise<void> {
  await getPool().query("DELETE FROM marmot_users WHERE id = $1", [id]);
}

export async function countUsers(): Promise<number> {
  const { rows } = await getPool().query("SELECT COUNT(*)::int AS n FROM marmot_users");
  return rows[0].n;
}
