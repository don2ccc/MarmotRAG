import pg from "pg";
import pgvector from "pgvector/pg";
import { createHash, randomUUID } from "node:crypto";
import { storeDim, canIndexVector } from "./embeddings.js";

const { Pool } = pg;

/** SHA-256 hex of a UTF-8 string — used for content and strategy fingerprints. */
export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// Strip surrounding quotes that some dotenv tools preserve (e.g. "dongdong" → dongdong)
function pgEnv(key: string, fallback: string): string {
  const val = process.env[key] ?? fallback;
  return val.replace(/^["']|["']$/g, "");
}

// Lazy pool — created on first use so that process.env is already populated by dotenv
let _pool: pg.Pool | null = null;

// Capabilities probed once in initDb(); used by the search path.
let HNSW_TUNING_SUPPORTED = false;
let HNSW_ITERATIVE_SCAN = false;

function getPool(): pg.Pool {
  if (!_pool) {
    _pool = new Pool({
      host:     pgEnv("PG_HOST",     "127.0.0.1"),
      port:     Number(pgEnv("PG_PORT", "5432")),
      user:     pgEnv("PG_USER",     "postgres"),
      password: pgEnv("PG_PASSWORD", ""),
      database: pgEnv("PG_DATABASE", "ai_hub"),
    });

    // NOTE: no pgvector type registration here.
    //
    // The old `pool.on("connect", client => registerTypes(client))` hook issued a
    // query from a listener whose promise the pool never awaits, so the first
    // statement on a fresh connection could run concurrently with it
    // ("client is already executing a query"). It was also unnecessary: no query
    // in this service ever selects an `embedding` column — vectors are only
    // written (as pgvector.toSql text) and compared server-side by `<=>`.
    // If that ever changes, register the parser inside a checkout wrapper, not
    // in a connect listener.
  }
  return _pool;
}

/**
 * One-time migration from the pre-version ("shadow build") schema:
 *   marmot_chunks.build_id  + marmot_sources.active_build/build_state/last_error
 *   →   marmot_doc_versions row + marmot_sources.current_version_id
 *
 * Safe to run on every boot: it does nothing when the legacy columns are absent.
 */
async function migrateLegacyBuilds(pool: pg.Pool): Promise<void> {
  const legacy = await columnExists(pool, "marmot_chunks", "build_id");
  if (!legacy) return;

  const { rows } = await pool.query(
    `SELECT s.id, s.content
       FROM marmot_sources s
      WHERE EXISTS (
              SELECT 1 FROM marmot_chunks c
               WHERE c.source_id = s.id AND c.version_id IS NULL
            )`
  );

  for (const row of rows) {
    const docId = row.id as string;
    const countRes = await pool.query(
      "SELECT count(*)::int AS n FROM marmot_chunks WHERE source_id = $1 AND version_id IS NULL",
      [docId]
    );
    const chunkCount = Number(countRes.rows[0]?.n ?? 0);
    if (chunkCount === 0) continue;

    const versionId = `ver-${randomUUID()}`;
    await pool.query(
      `INSERT INTO marmot_doc_versions
         (id, doc_id, version_no, content_sha256, state, chunk_count, activated_at)
       VALUES ($1, $2, 1, $3, 'active', $4, now())`,
      [versionId, docId, sha256(String(row.content ?? "")), chunkCount]
    );
    await pool.query(
      "UPDATE marmot_chunks SET version_id = $1 WHERE source_id = $2 AND version_id IS NULL",
      [versionId, docId]
    );
    await pool.query(
      `UPDATE marmot_sources
          SET current_version_id = $1, vectors_count = $2
        WHERE id = $3 AND current_version_id IS NULL`,
      [versionId, chunkCount, docId]
    );
  }

  await pool.query(`ALTER TABLE marmot_chunks DROP COLUMN IF EXISTS build_id`);
  await pool.query(`ALTER TABLE marmot_sources DROP COLUMN IF EXISTS active_build`);
  await pool.query(`ALTER TABLE marmot_sources DROP COLUMN IF EXISTS build_state`);
  await pool.query(`ALTER TABLE marmot_sources DROP COLUMN IF EXISTS last_error`);
  console.log("[db] migrated legacy shadow-build rows to doc versions");
}

async function columnExists(pool: pg.Pool, table: string, column: string): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2
      LIMIT 1`,
    [table, column]
  );
  return rows.length > 0;
}

/**
 * Add a foreign key once, removing orphan rows first so the constraint can be
 * created on an existing database. Identifiers are fixed literals at call sites.
 */
async function ensureForeignKey(
  pool: pg.Pool,
  name: string,
  table: string,
  column: string,
  refTable: string,
  onDelete: "CASCADE" | "SET NULL"
): Promise<void> {
  const existing = await pool.query("SELECT 1 FROM pg_constraint WHERE conname = $1", [name]);
  if (existing.rows.length > 0) return;

  await pool.query(
    `DELETE FROM ${table}
      WHERE ${column} IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM ${refTable} r WHERE r.id = ${table}.${column})`
  );
  await pool.query(
    `ALTER TABLE ${table}
       ADD CONSTRAINT ${name} FOREIGN KEY (${column})
       REFERENCES ${refTable}(id) ON DELETE ${onDelete}`
  );
}

/**
 * Create the pgvector extension (if needed) and all marmot_* tables.
 * Called once at server startup. All migrations are idempotent so they are
 * safe to run on every boot.
 */
export async function initDb(): Promise<void> {
  const pool = getPool();
  const dim = storeDim();

  await pool.query("CREATE EXTENSION IF NOT EXISTS vector");
  // Trigram matching powers the lexical channel (文号 / 合同编号 / 料号 / 条款号).
  await pool.query("CREATE EXTENSION IF NOT EXISTS pg_trgm");

  // ── Documents ────────────────────────────────────────────────────────
  // marmot_sources is the document row: metadata, owner, the full `content`
  // (the only thing needed to rebuild after a model change) and a pointer to the
  // version currently being served.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS marmot_sources (
      id                 TEXT PRIMARY KEY,
      name               TEXT NOT NULL,
      type               TEXT NOT NULL DEFAULT 'Text Document',
      status             TEXT NOT NULL DEFAULT 'Synced',
      last_sync          TEXT NOT NULL DEFAULT '',
      vectors_count      INTEGER NOT NULL DEFAULT 0,
      owner              TEXT NOT NULL DEFAULT 'You',
      owner_avatar       TEXT NOT NULL DEFAULT '',
      owner_id           TEXT NOT NULL DEFAULT '',
      is_shared          BOOLEAN NOT NULL DEFAULT FALSE,
      content            TEXT NOT NULL DEFAULT '',
      kind               TEXT NOT NULL DEFAULT 'document',
      doc_no             TEXT,
      current_version_id TEXT
    )
  `);
  await pool.query(`ALTER TABLE marmot_sources ADD COLUMN IF NOT EXISTS owner_id TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE marmot_sources ADD COLUMN IF NOT EXISTS is_shared BOOLEAN NOT NULL DEFAULT FALSE`);
  await pool.query(`ALTER TABLE marmot_sources ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'document'`);
  await pool.query(`ALTER TABLE marmot_sources ADD COLUMN IF NOT EXISTS doc_no TEXT`);
  await pool.query(`ALTER TABLE marmot_sources ADD COLUMN IF NOT EXISTS current_version_id TEXT`);
  await pool.query(`UPDATE marmot_sources SET owner_id = 'u-1' WHERE owner_id = ''`);

  // ── Versions ─────────────────────────────────────────────────────────
  // One row per complete index snapshot. `current_version_id` on the document is
  // the single source of truth for what is served, and switching it is one
  // transaction. Superseded versions keep their metadata for as-of/rollback
  // (their chunks are dropped to bound storage; see docs T4).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS marmot_doc_versions (
      id                  TEXT PRIMARY KEY,
      doc_id              TEXT NOT NULL REFERENCES marmot_sources(id) ON DELETE CASCADE,
      version_no          INTEGER NOT NULL,
      content_sha256      TEXT NOT NULL DEFAULT '',
      state               TEXT NOT NULL,
      lifecycle           TEXT NOT NULL DEFAULT 'effective',
      last_error          TEXT,
      chunk_count         INTEGER NOT NULL DEFAULT 0,
      chunk_strategy_hash TEXT NOT NULL DEFAULT '',
      embedding_model     TEXT NOT NULL DEFAULT '',
      embedding_dim       INTEGER NOT NULL DEFAULT 0,
      effective_from      TIMESTAMPTZ,
      effective_to        TIMESTAMPTZ,
      signed_at           TIMESTAMPTZ,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
      activated_at        TIMESTAMPTZ,
      UNIQUE (doc_id, version_no)
    )
  `);
  await pool.query(`ALTER TABLE marmot_doc_versions ADD COLUMN IF NOT EXISTS lifecycle TEXT NOT NULL DEFAULT 'effective'`);
  await pool.query(`ALTER TABLE marmot_doc_versions ADD COLUMN IF NOT EXISTS signed_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE marmot_doc_versions ADD COLUMN IF NOT EXISTS effective_from TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE marmot_doc_versions ADD COLUMN IF NOT EXISTS effective_to TIMESTAMPTZ`);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS marmot_doc_versions_doc_idx
    ON marmot_doc_versions (doc_id, version_no DESC)
  `);

  // ── Chunks ───────────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS marmot_chunks (
      id                TEXT PRIMARY KEY,
      version_id        TEXT,
      source_id         TEXT NOT NULL,
      source_name       TEXT NOT NULL,
      ordinal           INTEGER,
      text              TEXT NOT NULL,
      tokens_count      INTEGER NOT NULL DEFAULT 0,
      char_start        INTEGER,
      char_end          INTEGER,
      clause_no         TEXT,
      clause_path       TEXT,
      page_from         INTEGER,
      content_sha256    TEXT,
      embed_input_chars INTEGER,
      embedding         vector(${dim})
    )
  `);
  for (const ddl of [
    `ADD COLUMN IF NOT EXISTS version_id TEXT`,
    `ADD COLUMN IF NOT EXISTS ordinal INTEGER`,
    `ADD COLUMN IF NOT EXISTS char_start INTEGER`,
    `ADD COLUMN IF NOT EXISTS char_end INTEGER`,
    `ADD COLUMN IF NOT EXISTS clause_no TEXT`,
    `ADD COLUMN IF NOT EXISTS clause_path TEXT`,
    `ADD COLUMN IF NOT EXISTS page_from INTEGER`,
    `ADD COLUMN IF NOT EXISTS content_sha256 TEXT`,
    `ADD COLUMN IF NOT EXISTS embed_input_chars INTEGER`,
  ]) {
    await pool.query(`ALTER TABLE marmot_chunks ${ddl}`);
  }

  // One-time move from the pre-version shadow-build columns (no-op when absent).
  await migrateLegacyBuilds(pool);

  // ── Embedding dimension reconciliation (no data destruction) ────────
  // pgvector encodes vector(n) typmod as either n or n+8 depending on version,
  // so both encodings count as a match; only a genuinely different dimension
  // triggers a rebuild.
  //
  // Formerly this path ran DROP TABLE, which wiped every vector and left the
  // startup heal marking all sources Paused forever. Now the rows survive with
  // NULL vectors and every source is marked stale: server.ts re-embeds them from
  // the retained `content` column, so a model change costs time, not knowledge.
  const dimCheck = await pool.query(`
    SELECT atttypmod
    FROM pg_attribute
    JOIN pg_class ON pg_class.oid = pg_attribute.attrelid
    WHERE pg_class.relname = 'marmot_chunks'
      AND pg_attribute.attname = 'embedding'
      AND pg_attribute.attnum > 0
  `);
  if (dimCheck.rows.length > 0) {
    const typmod = Number(dimCheck.rows[0].atttypmod);
    const matches = typmod === dim || typmod === dim + 8;
    if (!matches) {
      console.warn(`[db] embedding dimension mismatch (typmod=${typmod}, want vector(${dim})) — clearing vectors and scheduling rebuild`);
      await pool.query("DROP INDEX IF EXISTS marmot_chunks_embedding_idx");
      await pool.query(
        `ALTER TABLE marmot_chunks ALTER COLUMN embedding TYPE vector(${dim}) USING NULL::vector(${dim})`
      );
      await pool.query(`UPDATE marmot_sources SET current_version_id = NULL, status = 'Paused'`);
      await pool.query(`UPDATE marmot_doc_versions SET state = 'superseded' WHERE state = 'active'`);
      console.log("[db] vectors cleared; documents will be re-embedded from stored content at startup");
    }
  }

  if (canIndexVector(dim)) {
    await pool.query(`
      CREATE INDEX IF NOT EXISTS marmot_chunks_embedding_idx
      ON marmot_chunks
      USING hnsw (embedding vector_cosine_ops)
      WITH (m = 16, ef_construction = 64)
    `);
  } else {
    console.warn(`[db] EMBED_STORE_DIM=${dim} exceeds pgvector's HNSW limit (2000); exact search only — consider halfvec`);
  }
  await pool.query(`CREATE INDEX IF NOT EXISTS marmot_chunks_source_idx ON marmot_chunks (source_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS marmot_chunks_version_idx ON marmot_chunks (version_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS marmot_chunks_text_trgm_idx ON marmot_chunks USING gin (text gin_trgm_ops)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS marmot_sources_doc_no_trgm_idx ON marmot_sources USING gin (doc_no gin_trgm_ops)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS marmot_sources_kind_idx ON marmot_sources (kind)`);
  await ensureForeignKey(pool, "marmot_chunks_version_fk", "marmot_chunks", "version_id", "marmot_doc_versions", "CASCADE");

  // HNSW runtime knobs are only available on a versioned index; probe once.
  try {
    const ext = await pool.query("SELECT extversion FROM pg_extension WHERE extname = 'vector'");
    const version = Number.parseFloat(String(ext.rows[0]?.extversion ?? "0"));
    HNSW_TUNING_SUPPORTED = canIndexVector(dim) && version >= 0.8;
    HNSW_ITERATIVE_SCAN = version >= 0.8;
  } catch {
    HNSW_TUNING_SUPPORTED = false;
    HNSW_ITERATIVE_SCAN = false;
  }

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
      retrieved_chunks TEXT NOT NULL DEFAULT '[]',
      retrieval_id     TEXT,
      diagnostics      TEXT
    )
  `);
  await pool.query(`ALTER TABLE marmot_query_logs ADD COLUMN IF NOT EXISTS user_id TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE marmot_query_logs ADD COLUMN IF NOT EXISTS via TEXT NOT NULL DEFAULT 'user'`);
  await pool.query(`ALTER TABLE marmot_query_logs ADD COLUMN IF NOT EXISTS retrieval_id TEXT`);
  await pool.query(`ALTER TABLE marmot_query_logs ADD COLUMN IF NOT EXISTS diagnostics TEXT`);
  await pool.query(`ALTER TABLE marmot_query_logs DROP COLUMN IF EXISTS pipeline`);
  await pool.query(`ALTER TABLE marmot_query_logs DROP COLUMN IF EXISTS answer`);
  await pool.query(`ALTER TABLE marmot_query_logs DROP COLUMN IF EXISTS faithfulness_score`);
  await pool.query(`ALTER TABLE marmot_query_logs DROP COLUMN IF EXISTS relevance_score`);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS marmot_query_logs_ts_idx
    ON marmot_query_logs (timestamp DESC)
  `);

  // Agent feedback on a retrieval: what was cited and whether it held up.
  // This is the only signal that can tell us whether retrieval actually helped.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS marmot_retrieval_feedback (
      id                TEXT PRIMARY KEY,
      retrieval_id      TEXT NOT NULL,
      verdict           TEXT NOT NULL,
      used_citation_ids TEXT NOT NULL DEFAULT '[]',
      missing_info      TEXT,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS marmot_retrieval_feedback_rid_idx
    ON marmot_retrieval_feedback (retrieval_id)
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

export interface ChunkRow {
  id: string;
  sourceId: string;
  sourceName: string;
  text: string;
  tokensCount: number;
  embedding: number[];
  ordinal?: number;
  charStart?: number;
  charEnd?: number;
  clauseNo?: string;
  clausePath?: string;
  contentSha256?: string;
  embedInputChars?: number;
}

/**
 * Insert a batch of chunks for one version.
 *
 * Chunk ids embed the version (`<sourceId>::<versionId>::<ordinal>`), so an
 * in-flight rebuild can never collide with — or overwrite — the version that is
 * currently being served.
 */
export async function insertChunkRows(versionId: string, rows: ChunkRow[]): Promise<void> {
  if (rows.length === 0) return;
  const params: unknown[] = [];
  const tuples: string[] = [];
  for (const row of rows) {
    const base = params.length;
    tuples.push(
      `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, ` +
      `$${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11}, $${base + 12}, ` +
      `$${base + 13}, $${base + 14})`
    );
    params.push(
      row.id,
      versionId,
      row.sourceId,
      row.sourceName,
      row.ordinal ?? null,
      sanitizeText(row.text),
      row.tokensCount,
      row.charStart ?? null,
      row.charEnd ?? null,
      row.clauseNo ?? null,
      row.clausePath ?? null,
      row.contentSha256 ?? null,
      row.embedInputChars ?? null,
      pgvector.toSql(row.embedding)
    );
  }
  await getPool().query(
    `INSERT INTO marmot_chunks
       (id, version_id, source_id, source_name, ordinal, text, tokens_count,
        char_start, char_end, clause_no, clause_path, content_sha256,
        embed_input_chars, embedding)
     VALUES ${tuples.join(", ")}
     ON CONFLICT (id) DO NOTHING`,
    params
  );
}

/** Delete all chunks belonging to a source document (every version). */
export async function deleteChunksBySource(sourceId: string): Promise<void> {
  await getPool().query(
    "DELETE FROM marmot_chunks WHERE source_id = $1",
    [sourceId]
  );
}

// ── Search layer (vector + lexical + filters) ─────────────────────────

export interface CandidateRow {
  id: string;
  sourceId: string;
  sourceName: string;
  text: string;
  tokensCount: number;
  score: number;
  versionId: string;
  versionNo: number;
  docId: string;
  docNo: string | null;
  kind: string;
  clauseNo: string | null;
  clausePath: string | null;
  charStart: number | null;
  charEnd: number | null;
  pageFrom: number | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  lifecycle: string;
  contentSha256: string | null;
  match: "vector" | "lexical";
}

export interface SearchFilter {
  userId: string;
  sourceFilter?: string[];
  excludeSourceIds?: string[];
  kinds?: string[];
  docIds?: string[];
  /** ISO timestamp: retrieve the version that was effective at that moment. */
  asOf?: string | null;
  includeExpired?: boolean;
}

const CANDIDATE_COLUMNS = `
  c.id, c.source_id, c.source_name, c.text, c.tokens_count,
  c.version_id, c.clause_no, c.clause_path, c.char_start, c.char_end,
  c.page_from, c.content_sha256,
  s.id AS doc_id, s.doc_no, s.kind,
  v.version_no, v.effective_from, v.effective_to, v.lifecycle
`;

function toIso(value: unknown): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function mapCandidate(row: Record<string, any>, match: "vector" | "lexical"): CandidateRow {
  return {
    id: row.id as string,
    sourceId: row.source_id as string,
    sourceName: row.source_name as string,
    text: row.text as string,
    tokensCount: Number(row.tokens_count ?? 0),
    score: Number(row.score ?? 0),
    versionId: row.version_id as string,
    versionNo: Number(row.version_no ?? 1),
    docId: row.doc_id as string,
    docNo: (row.doc_no as string | null) ?? null,
    kind: (row.kind as string | null) ?? "document",
    clauseNo: (row.clause_no as string | null) ?? null,
    clausePath: (row.clause_path as string | null) ?? null,
    charStart: row.char_start === null || row.char_start === undefined ? null : Number(row.char_start),
    charEnd: row.char_end === null || row.char_end === undefined ? null : Number(row.char_end),
    pageFrom: row.page_from === null || row.page_from === undefined ? null : Number(row.page_from),
    effectiveFrom: toIso(row.effective_from),
    effectiveTo: toIso(row.effective_to),
    lifecycle: row.lifecycle as string,
    contentSha256: (row.content_sha256 as string | null) ?? null,
    match,
  };
}

/** Build the shared visibility / version / time predicates. */
function buildFilter(filter: SearchFilter, params: unknown[]): string[] {
  const add = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };

  const clauses: string[] = [
    `s.status = 'Synced'`,
    `(s.owner_id = ${add(filter.userId)} OR s.is_shared = TRUE)`,
    `v.lifecycle = 'effective'`,
  ];

  if (filter.asOf) {
    const at = add(filter.asOf);
    clauses.push(`(
      (v.effective_from IS NULL OR v.effective_from <= ${at}::timestamptz)
      AND (v.effective_to IS NULL OR v.effective_to > ${at}::timestamptz)
    )`);
  } else {
    clauses.push(`c.version_id = s.current_version_id`);
    if (!filter.includeExpired) {
      clauses.push(`(v.effective_to IS NULL OR v.effective_to > now())`);
    }
  }

  if (filter.sourceFilter?.length) {
    clauses.push(`c.source_id = ANY(${add(filter.sourceFilter)}::text[])`);
  }
  if (filter.excludeSourceIds?.length) {
    clauses.push(`c.source_id <> ALL(${add(filter.excludeSourceIds)}::text[])`);
  }
  if (filter.kinds?.length) {
    clauses.push(`s.kind = ANY(${add(filter.kinds)}::text[])`);
  }
  if (filter.docIds?.length) {
    clauses.push(`s.id = ANY(${add(filter.docIds)}::text[])`);
  }
  return clauses;
}

/**
 * Run a search statement with HNSW tuning applied for the duration of one
 * transaction. SET LOCAL scopes the settings to this query instead of leaking
 * them into the pooled connection's next user.
 */
async function withSearchClient<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    if (HNSW_TUNING_SUPPORTED) {
      await client.query("SET LOCAL hnsw.ef_search = 100");
      if (HNSW_ITERATIVE_SCAN) {
        await client.query("SET LOCAL hnsw.iterative_scan = relaxed_order");
        await client.query("SET LOCAL hnsw.max_scan_tuples = 20000");
      }
    }
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => { /* already failing */ });
    throw err;
  } finally {
    client.release();
  }
}

/** Nearest chunks by embedding distance. */
export async function searchVector(
  queryEmbedding: number[],
  limit: number,
  filter: SearchFilter
): Promise<CandidateRow[]> {
  const params: unknown[] = [pgvector.toSql(queryEmbedding)];
  const vec = "$1";
  const where = buildFilter(filter, params);
  params.push(Math.max(1, Math.min(200, Math.round(limit))));
  const lim = `$${params.length}`;

  return withSearchClient(async (client) => {
    const { rows } = await client.query(
      `SELECT ${CANDIDATE_COLUMNS}, 1 - (c.embedding <=> ${vec}) AS score
         FROM marmot_chunks c
         JOIN marmot_sources s ON s.id = c.source_id
         JOIN marmot_doc_versions v ON v.id = c.version_id
        WHERE c.embedding IS NOT NULL AND ${where.join(" AND ")}
        ORDER BY c.embedding <=> ${vec}
        LIMIT ${lim}`,
      params
    );
    return rows.map(row => mapCandidate(row, "vector"));
  });
}

function escapeLike(key: string): string {
  return key.replace(/[\\%_]/g, ch => `\\${ch}`);
}

/**
 * Identifier-oriented lexical matches: 文号, 合同编号, 料号, 条款号.
 * Trigram ILIKE keeps this usable for CJK without a Chinese FTS dictionary.
 */
export async function searchLexical(
  keys: string[],
  limit: number,
  filter: SearchFilter
): Promise<CandidateRow[]> {
  if (keys.length === 0) return [];

  const params: unknown[] = [];
  const where = buildFilter(filter, params);

  params.push(keys.map(k => `%${escapeLike(k)}%`));
  const patterns = `$${params.length}`;
  params.push(keys);
  const exact = `$${params.length}`;
  params.push(keys.join(" "));
  const query = `$${params.length}`;
  params.push(Math.max(1, Math.min(200, Math.round(limit))));
  const lim = `$${params.length}`;

  where.push(`(
    c.text ILIKE ANY(${patterns}::text[])
    OR c.clause_no = ANY(${exact}::text[])
    OR s.doc_no ILIKE ANY(${patterns}::text[])
  )`);

  const { rows } = await getPool().query(
    `SELECT ${CANDIDATE_COLUMNS},
            GREATEST(
              similarity(c.text, ${query}),
              CASE WHEN c.clause_no = ANY(${exact}::text[]) THEN 1 ELSE 0 END,
              CASE WHEN s.doc_no ILIKE ANY(${patterns}::text[]) THEN 0.9 ELSE 0 END
            ) AS score
       FROM marmot_chunks c
       JOIN marmot_sources s ON s.id = c.source_id
       JOIN marmot_doc_versions v ON v.id = c.version_id
      WHERE ${where.join(" AND ")}
      ORDER BY score DESC
      LIMIT ${lim}`,
    params
  );
  return rows.map(row => mapCandidate(row, "lexical"));
}

/** Vector-only wrapper kept for tests and simple callers. */
export async function searchChunks(
  queryEmbedding: number[],
  topK: number,
  opts: { userId: string; sourceFilter?: string[]; excludeSourceIds?: string[] }
): Promise<{ id: string; sourceId: string; sourceName: string; text: string; tokensCount: number; score: number }[]> {
  const rows = await searchVector(queryEmbedding, topK, {
    userId: opts.userId,
    sourceFilter: opts.sourceFilter,
    excludeSourceIds: opts.excludeSourceIds,
  });
  return rows.map(row => ({
    id: row.id,
    sourceId: row.sourceId,
    sourceName: row.sourceName,
    text: row.text,
    tokensCount: row.tokensCount,
    score: row.score,
  }));
}

// ── Version lifecycle (shadow build → atomic switch) ──────────────────
//
// A rebuild never mutates the chunks that are currently served:
//   1. beginVersion()  inserts a `building` version row and returns its id.
//   2. chunks are written against that version_id (current version untouched).
//   3. commitVersion() switches current_version_id inside one transaction and
//      marks the previous version `superseded`.
//   4. abortVersion()  drops the failed version's chunks and records the error;
//      the document keeps serving its previous version.
//
// This replaces the original "DELETE all chunks, then re-embed" flow, which made
// a document disappear from retrieval for the whole rebuild — and forever if the
// rebuild failed.

export class VersionInProgressError extends Error {
  constructor(docId: string) {
    super(`a version build is already running for document ${docId}`);
    this.name = "VersionInProgressError";
  }
}

export interface VersionMeta {
  contentSha256: string;
  strategyHash: string;
  embeddingModel: string;
  embeddingDim: number;
  /** Editorial validity: effective | draft | expired | revoked. */
  lifecycle?: string;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
  signedAt?: string | null;
}

export async function beginVersion(docId: string, meta: VersionMeta): Promise<string> {
  const pool = getPool();
  const exists = await pool.query("SELECT 1 FROM marmot_sources WHERE id = $1", [docId]);
  if (exists.rows.length === 0) throw new Error(`document ${docId} not found`);

  const building = await pool.query(
    "SELECT id FROM marmot_doc_versions WHERE doc_id = $1 AND state = 'building' LIMIT 1",
    [docId]
  );
  if (building.rows.length > 0) throw new VersionInProgressError(docId);

  const versionId = `ver-${randomUUID()}`;
  await pool.query(
    `INSERT INTO marmot_doc_versions
       (id, doc_id, version_no, content_sha256, state, chunk_strategy_hash,
        embedding_model, embedding_dim, lifecycle, effective_from, effective_to, signed_at)
     SELECT $2, $1, COALESCE(MAX(version_no), 0) + 1, $3, 'building', $4, $5, $6,
            COALESCE($7, 'effective'), $8::timestamptz, $9::timestamptz, $10::timestamptz
       FROM marmot_doc_versions
      WHERE doc_id = $1`,
    [
      docId, versionId, meta.contentSha256, meta.strategyHash, meta.embeddingModel, meta.embeddingDim,
      meta.lifecycle ?? null, meta.effectiveFrom ?? null, meta.effectiveTo ?? null, meta.signedAt ?? null,
    ]
  );
  return versionId;
}

/** Promote `versionId` and drop every other version's chunks for this document. */
export async function commitVersion(opts: {
  docId: string;
  versionId: string;
  chunkCount: number;
}): Promise<{ lastSync: string; versionNo: number }> {
  const pool = getPool();
  const client = await pool.connect();
  const lastSync = new Date().toISOString();
  try {
    await client.query("BEGIN");
    // Keep the newest N versions (default 5) so `asOf` can still resolve recent
    // history. Older versions keep their metadata row but lose their chunks.
    const retention = Math.max(1, Math.min(100, Number(process.env.VERSION_RETENTION ?? 5) || 5));
    await client.query(
      `DELETE FROM marmot_chunks c
         USING marmot_doc_versions v
        WHERE c.version_id = v.id
          AND v.doc_id = $1
          AND v.id <> $2
          AND v.version_no <= (
                SELECT COALESCE(MAX(version_no), 0) - $3
                  FROM marmot_doc_versions
                 WHERE doc_id = $1
              )`,
      [opts.docId, opts.versionId, retention]
    );
    const versionRes = await client.query(
      `UPDATE marmot_doc_versions
          SET state = 'active', activated_at = now(), chunk_count = $2, last_error = NULL
        WHERE id = $1
        RETURNING version_no`,
      [opts.versionId, opts.chunkCount]
    );
    const versionNo = Number(versionRes.rows[0]?.version_no ?? 0);
    await client.query(
      `UPDATE marmot_doc_versions
          SET state = 'superseded'
        WHERE doc_id = $1 AND id <> $2 AND state = 'active'`,
      [opts.docId, opts.versionId]
    );
    const res = await client.query(
      `UPDATE marmot_sources
          SET current_version_id = $2,
              status            = 'Synced',
              vectors_count     = $3,
              last_sync         = $4
        WHERE id = $1`,
      [opts.docId, opts.versionId, opts.chunkCount, lastSync]
    );
    if (res.rowCount === 0) throw new Error(`document ${opts.docId} disappeared during build`);
    await client.query("COMMIT");
    return { lastSync, versionNo };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => { /* already failing */ });
    throw err;
  } finally {
    client.release();
  }
}

export async function abortVersion(docId: string, versionId: string, reason: string): Promise<void> {
  const pool = getPool();
  await pool.query("DELETE FROM marmot_chunks WHERE version_id = $1", [versionId])
    .catch(err => console.warn("[version] failed to drop aborted chunks:", err));

  await pool.query(
    "UPDATE marmot_doc_versions SET state = 'failed', last_error = $2 WHERE id = $1",
    [versionId, sanitizeText(reason).slice(0, 2000)]
  );
  // Only a document that has never been indexed successfully loses its status.
  await pool.query(
    `UPDATE marmot_sources
        SET status = CASE WHEN current_version_id IS NULL THEN 'Auth Error' ELSE status END
      WHERE id = $1`,
    [docId]
  );
}

export async function isVersionBuilding(docId: string): Promise<boolean> {
  const { rows } = await getPool().query(
    "SELECT 1 FROM marmot_doc_versions WHERE doc_id = $1 AND state = 'building' LIMIT 1",
    [docId]
  );
  return rows.length > 0;
}

/**
 * Startup repair: a `building` version can never be resumed (its chunks are
 * incomplete), so drop its chunks and mark it failed. Pointers to versions that
 * are no longer active are cleared, which queues the document for a rebuild.
 */
export async function recoverInterruptedVersions(): Promise<{ interrupted: number; cleared: number }> {
  const pool = getPool();
  const { rows } = await pool.query("SELECT id FROM marmot_doc_versions WHERE state = 'building'");
  for (const row of rows) {
    await pool.query("DELETE FROM marmot_chunks WHERE version_id = $1", [row.id]);
    await pool.query(
      "UPDATE marmot_doc_versions SET state = 'failed', last_error = $2 WHERE id = $1",
      [row.id, "interrupted at startup"]
    );
  }

  const cleared = await pool.query(
    `UPDATE marmot_sources s
        SET current_version_id = NULL, status = 'Paused'
      WHERE s.current_version_id IS NOT NULL
        AND NOT EXISTS (
              SELECT 1 FROM marmot_doc_versions v
               WHERE v.id = s.current_version_id AND v.state = 'active'
            )`
  );

  return { interrupted: rows.length, cleared: cleared.rowCount ?? 0 };
}

export interface DocVersionState {
  id: string;
  name: string;
  status: string;
  currentVersionId: string | null;
  versionNo: number | null;
  versionCount: number;
  vectorsCount: number;
  contentLength: number;
  kind: string;
  docNo: string | null;
  lifecycle: string | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
}

/** Startup view of every document, its current version and version count. */
export async function loadVersionStates(): Promise<DocVersionState[]> {
  const { rows } = await getPool().query(
    `SELECT s.id, s.name, s.status, s.current_version_id, s.vectors_count,
            s.kind, s.doc_no, length(s.content) AS content_length,
            v.version_no, v.lifecycle, v.effective_from, v.effective_to,
            (SELECT count(*)::int FROM marmot_doc_versions dv WHERE dv.doc_id = s.id) AS version_count
       FROM marmot_sources s
       LEFT JOIN marmot_doc_versions v ON v.id = s.current_version_id
      ORDER BY s.id`
  );
  return rows.map(r => ({
    id: r.id as string,
    name: r.name as string,
    status: r.status as string,
    currentVersionId: (r.current_version_id as string | null) ?? null,
    versionNo: r.version_no === null || r.version_no === undefined ? null : Number(r.version_no),
    versionCount: Number(r.version_count ?? 0),
    vectorsCount: Number(r.vectors_count ?? 0),
    contentLength: Number(r.content_length ?? 0),
    kind: (r.kind as string | null) ?? "document",
    docNo: (r.doc_no as string | null) ?? null,
    lifecycle: (r.lifecycle as string | null) ?? null,
    effectiveFrom: toIso(r.effective_from),
    effectiveTo: toIso(r.effective_to),
  }));
}

/** Documents with no servable version but stored content to rebuild from. */
export async function listRebuildCandidates(): Promise<{ id: string; name: string }[]> {
  const { rows } = await getPool().query(
    `SELECT id, name
       FROM marmot_sources
      WHERE current_version_id IS NULL
        AND length(content) > 0
      ORDER BY id`
  );
  return rows.map(r => ({ id: r.id as string, name: r.name as string }));
}

export interface DocVersionInfo {
  id: string;
  versionNo: number;
  state: string;
  chunkCount: number;
  contentSha256: string;
  embeddingModel: string;
  embeddingDim: number;
  activatedAt: string | null;
  lastError: string | null;
}

/** Version history, used by diagnostics and the shadow-build test. */
export async function listVersions(docId: string): Promise<DocVersionInfo[]> {
  const { rows } = await getPool().query(
    `SELECT id, version_no, state, chunk_count, content_sha256, embedding_model,
            embedding_dim, activated_at, last_error
       FROM marmot_doc_versions
      WHERE doc_id = $1
      ORDER BY version_no`,
    [docId]
  );
  return rows.map(r => ({
    id: r.id as string,
    versionNo: Number(r.version_no),
    state: r.state as string,
    chunkCount: Number(r.chunk_count ?? 0),
    contentSha256: r.content_sha256 as string,
    embeddingModel: r.embedding_model as string,
    embeddingDim: Number(r.embedding_dim ?? 0),
    activatedAt: r.activated_at ? new Date(r.activated_at as string).toISOString() : null,
    lastError: (r.last_error as string | null) ?? null,
  }));
}

/** Keep the denormalized source_name on chunks in sync with a rename. */
export async function renameChunksSourceName(sourceId: string, name: string): Promise<void> {
  await getPool().query(
    "UPDATE marmot_chunks SET source_name = $2 WHERE source_id = $1",
    [sourceId, name]
  );
}

// ── Document metadata & agent read/update support ─────────────────────

export interface SourceDetail {
  id: string;
  name: string;
  type: string;
  kind: string;
  docNo: string | null;
  status: string;
  ownerId: string;
  isShared: boolean;
  content: string;
  currentVersionId: string | null;
  versionNo: number | null;
  contentSha256: string | null;
  chunkCount: number | null;
  lifecycle: string | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  signedAt: string | null;
  lastSync: string;
  vectorsCount: number;
}

/** Document + its current version, for read-modify-write by agents. */
export async function getSourceDetail(docId: string): Promise<SourceDetail | null> {
  const { rows } = await getPool().query(
    `SELECT s.id, s.name, s.type, s.kind, s.doc_no, s.status, s.owner_id, s.is_shared,
            s.content, s.current_version_id, s.last_sync, s.vectors_count,
            v.version_no, v.content_sha256, v.chunk_count, v.lifecycle,
            v.effective_from, v.effective_to, v.signed_at
       FROM marmot_sources s
       LEFT JOIN marmot_doc_versions v ON v.id = s.current_version_id
      WHERE s.id = $1`,
    [docId]
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    id: r.id,
    name: r.name,
    type: r.type,
    kind: r.kind ?? "document",
    docNo: r.doc_no ?? null,
    status: r.status,
    ownerId: r.owner_id,
    isShared: r.is_shared,
    content: r.content,
    currentVersionId: r.current_version_id ?? null,
    versionNo: r.version_no === null || r.version_no === undefined ? null : Number(r.version_no),
    contentSha256: r.content_sha256 ?? null,
    chunkCount: r.chunk_count === null || r.chunk_count === undefined ? null : Number(r.chunk_count),
    lifecycle: r.lifecycle ?? null,
    effectiveFrom: toIso(r.effective_from),
    effectiveTo: toIso(r.effective_to),
    signedAt: toIso(r.signed_at),
    lastSync: r.last_sync,
    vectorsCount: Number(r.vectors_count ?? 0),
  };
}

/** Update document-level metadata (kind / doc_no / display name / type). */
export async function updateSourceMeta(
  docId: string,
  meta: { name?: string; type?: string; kind?: string; docNo?: string | null }
): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [];
  const set = (column: string, value: unknown): void => {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  };
  if (meta.name !== undefined) set("name", meta.name);
  if (meta.type !== undefined) set("type", meta.type);
  if (meta.kind !== undefined) set("kind", meta.kind);
  if (meta.docNo !== undefined) set("doc_no", meta.docNo);
  if (sets.length === 0) return;
  params.push(docId);
  await getPool().query(
    `UPDATE marmot_sources SET ${sets.join(", ")} WHERE id = $${params.length}`,
    params
  );
}

/** Update editorial validity on the version currently being served. */
export async function updateCurrentVersionValidity(
  docId: string,
  fields: {
    lifecycle?: string;
    effectiveFrom?: string | null;
    effectiveTo?: string | null;
    signedAt?: string | null;
  }
): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [];
  const set = (column: string, value: unknown, cast = ""): void => {
    params.push(value);
    sets.push(`${column} = $${params.length}${cast}`);
  };
  if (fields.lifecycle !== undefined) set("lifecycle", fields.lifecycle);
  if (fields.effectiveFrom !== undefined) set("effective_from", fields.effectiveFrom, "::timestamptz");
  if (fields.effectiveTo !== undefined) set("effective_to", fields.effectiveTo, "::timestamptz");
  if (fields.signedAt !== undefined) set("signed_at", fields.signedAt, "::timestamptz");
  if (sets.length === 0) return;

  params.push(docId);
  await getPool().query(
    `UPDATE marmot_doc_versions
        SET ${sets.join(", ")}
      WHERE id = (SELECT current_version_id FROM marmot_sources WHERE id = $${params.length})`,
    params
  );
}

export interface RetrievalFeedback {
  id: string;
  retrievalId: string;
  verdict: string;
  usedCitationIds: string[];
  missingInfo: string | null;
  createdAt: string;
}

export async function insertFeedback(feedback: RetrievalFeedback): Promise<void> {
  await getPool().query(
    `INSERT INTO marmot_retrieval_feedback
       (id, retrieval_id, verdict, used_citation_ids, missing_info)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      feedback.id,
      feedback.retrievalId,
      feedback.verdict,
      JSON.stringify(feedback.usedCitationIds),
      feedback.missingInfo,
    ]
  );
}

/** True when a retrieval id exists (feedback must reference a real retrieval). */
export async function retrievalExists(retrievalId: string): Promise<boolean> {
  const { rows } = await getPool().query(
    "SELECT 1 FROM marmot_query_logs WHERE retrieval_id = $1 LIMIT 1",
    [retrievalId]
  );
  return rows.length > 0;
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

/** Load the *current* version's chunks for a document (chunk-preview feature). */
export async function loadChunksBySource(
  sourceId: string,
  limit = 10
): Promise<{ id: string; text: string; tokensCount: number }[]> {
  const { rows } = await getPool().query(
    `SELECT c.id, c.text, c.tokens_count
       FROM marmot_chunks c
       JOIN marmot_sources s ON s.id = c.source_id
      WHERE c.source_id = $1
        AND c.version_id = s.current_version_id
      ORDER BY c.ordinal NULLS LAST, c.id
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
  retrievedChunks: { chunkId: string; citationId?: string; sourceName: string; text: string; score: number }[];
  /** Stable id handed back to the agent; feedback references it. */
  retrievalId?: string | null;
  /** Search diagnostics (hits per channel, best score, degraded flag...). */
  diagnostics?: unknown;
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
       (id, timestamp, query, user_id, via, latency_ms, status, retrieved_chunks,
        retrieval_id, diagnostics)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (id) DO NOTHING`,
    [log.id, log.timestamp, sanitizeText(log.query), log.userId, log.via,
     log.latencyMs, log.status, JSON.stringify(log.retrievedChunks),
     log.retrievalId ?? null, log.diagnostics ? JSON.stringify(log.diagnostics) : null]
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
