# MarmotRAG — Production Readiness Plan

## Overview

A systematic review of MarmotRAG from a Senior AI/RAG Product and Engineering perspective. The platform is a strong MVP but has a number of critical blockers and high-priority gaps before it can be considered production-grade. This plan organizes all findings into independently-implementable sub-tasks, ordered by severity and dependency.

**Current estimated production readiness: ~20%**  
**Target: delivery-ready for enterprise handoff**

---

## Severity Classification

- 🔴 **BLOCKER** — Data loss, security breach, or incorrect data being shown to users  
- 🟠 **HIGH** — System unreliability, crashes, or significant UX degradation  
- 🟡 **MEDIUM** — Feature gaps, code quality, or maintainability issues  
- 🟢 **LOW** — Polish, documentation, minor UX improvements

---

## Sub-Tasks

---

### ST-1 — Database Persistence for All Business State

**Status**: `[ ] pending`

**Severity**: 🔴 BLOCKER

**Intent**  
All critical system state — pipelines, strategy config, agent API keys, query logs, users — is currently held only in server memory and is wiped on every restart. A production system cannot operate this way.

**Problem Detail**
- `pipelines[]` — CRUD routes work against in-memory array only
- `strategyConfig` — saved via `POST /api/config` but reverts on restart
- `agentKeys[]` — all issued keys lost on restart; agents stop working
- `queryLogs[]` — audit history wiped; also grows unboundedly (memory leak)
- `users[]` — mock in-memory only

**Expected Outcomes**
- All five data types survive a server restart
- Query logs have a configurable retention cap (default: keep last 10,000 entries)
- `loadData()` / startup initializes all state from DB, same pattern as `initializeSources()`

**Todo List**
1. Add DB tables in `src/db.ts`:  `marmot_pipelines`, `marmot_config`, `marmot_agent_keys`, `marmot_query_logs`, `marmot_users`
2. Add CRUD helpers in `src/db.ts` for each table (upsert, load, delete)
3. On server startup (`startServer()`), load all five into their respective in-memory arrays
4. On every mutating API route (create/update/delete), persist to DB immediately (same async pattern as `upsertSource`)
5. Cap `queryLogs` at 10,000 entries in memory; prune oldest entries when inserting into DB
6. Mark `queryLogs` timestamp as full ISO 8601 string, not just time portion

**Relevant Context**
- See `src/db.ts` `initDb()` and `initializeSources()` for the pattern to follow
- `marmot_sources` table is the reference for upsert patterns
- `server.ts` lines 260–290: `strategyConfig` initial values become the schema default row
- `server.ts` lines 364–400: `pipelines` seed array becomes the initial DB rows
- `server.ts` lines 431–474: `queryLogs` seed entries become initial rows
- `server.ts` lines 477–481: `users` seed entries become initial rows
- `server.ts` lines 1002–1030: `agentKeys` seed entry becomes initial DB row

---

### ST-2 — Security: Admin Auth on Agent Key Management Endpoints

**Status**: `[ ] pending`

**Severity**: 🔴 BLOCKER

**Intent**  
The four agent key management endpoints (`GET/POST/PATCH/DELETE /api/agent/keys`) are completely unauthenticated. Any caller — malicious or accidental — can list all keys, create unlimited new keys, or revoke every key in the system, immediately breaking all agent integrations.

**Problem Detail**
- `GET /api/agent/keys` — exposes all key metadata to anyone
- `POST /api/agent/keys` — any caller can create unlimited keys with no rate limit
- `PATCH /api/agent/keys/:id` — any caller can disable all keys
- `DELETE /api/agent/keys/:id` — any caller can revoke any key

Additionally, the response from `GET /api/agent/keys` currently spreads the full key record including the internal `_monthStamp` field via `{ ...k, key: undefined }`. The key field is omitted but `_monthStamp` leaks.

**Expected Outcomes**
- Management endpoints require a bearer token / admin secret header (`Authorization: Bearer <ADMIN_SECRET>`)
- `ADMIN_SECRET` is read from environment variable; startup logs a warning if not set
- `_monthStamp` is excluded from all API responses
- The `key` field is explicitly excluded (not just set to undefined) from list responses

**Todo List**
1. Add `ADMIN_SECRET` env variable (add to `.env.example` and `README.md`)
2. Implement `adminAuth` middleware in `server.ts` that checks `Authorization: Bearer <ADMIN_SECRET>`
3. Apply `adminAuth` to all four `/api/agent/keys` management routes
4. Fix the `GET /api/agent/keys` response to explicitly strip `_monthStamp` and `key` by destructuring, not spreading
5. Apply same fix to `PATCH /api/agent/keys/:id` response

**Relevant Context**
- `server.ts` lines 1092–1143: the four management routes
- `server.ts` line 1093: the `{ ...k, key: undefined }` spread bug
- `agentAuth` middleware (line 1043) is the reference pattern for a middleware function
- `.env.example` should be updated alongside

---

### ST-3 — Security: CORS, Security Headers, Input Validation

**Status**: `[ ] pending`

**Severity**: 🔴 BLOCKER (CORS) / 🟠 HIGH (headers, validation)

**Intent**  
Without CORS headers, browser-based agents and the Playground tab cannot make cross-origin requests to the API. Without security headers, the admin dashboard is vulnerable to XSS, clickjacking, and content-sniffing attacks. Without input validation, malformed or oversized requests can crash the server or fill the DB.

**Problem Detail**
- No `cors()` middleware — blocks browser-based agents
- No `helmet()` — no CSP, X-Frame-Options, HSTS, etc.
- `express.json({ limit: "50mb" })` is appropriate for PDF uploads, but all other routes should have a lower limit
- No query length cap on `/api/query` and `/api/agent/query`
- No label length cap on `/api/agent/keys POST`
- No bounds validation on `topK` (could be 10,000), `rateLimit` (could be -1 or 999999)
- Port hardcoded to 3000 — should read from `process.env.PORT`

**Expected Outcomes**
- CORS origins configurable via `CORS_ORIGINS` env var (default: `*` for dev, must be set for prod)
- `helmet()` applied with sensible defaults
- Input validation on all mutating routes: string length caps, numeric range clamps
- `PORT` read from environment

**Todo List**
1. Install `cors` and `helmet` packages; add to `package.json`
2. Apply `app.use(cors({ origin: process.env.CORS_ORIGINS?.split(",") || "*" }))` before routes
3. Apply `app.use(helmet())` before routes; tune CSP to allow Vite dev assets in dev mode
4. Read `const PORT = Number(process.env.PORT) || 3000`
5. Add validation middleware or inline guards for: query max 10,000 chars, label max 200 chars, topK clamp 1–20, minScore clamp 0–1, rateLimit clamp 0–600, chunkSize clamp 64–4096, chunkOverlap clamp 0–50
6. Add global Express error handler as last middleware in `server.ts`

**Relevant Context**
- `server.ts` line 18: hardcoded PORT
- `server.ts` line 20: `express.json({ limit: "50mb" })` — keep for `/api/parse-pdf`, tighten for others
- `server.ts` line 757: `/api/query` — no input validation
- `server.ts` line 1172: `/api/agent/retrieve` — no topK/minScore bounds

---

### ST-4 — Eliminate Code Duplication: Shared executeRAGQuery() Core

**Status**: `[ ] pending`

**Severity**: 🟠 HIGH

**Intent**  
`POST /api/query` (dashboard/playground, ~140 lines) and `POST /api/agent/query` (agent-facing, ~160 lines) share ~90% of the same logic: embed query, vector search, apply filters, generate answer with Gemini/Ollama, build log entry. Any bug fix or feature addition must be applied to both. This will inevitably diverge.

**Expected Outcomes**
- Single `executeRAGQuery(params)` internal async function containing the shared logic
- Both `/api/query` and `/api/agent/query` become thin wrappers that call it
- No behavior change; existing tests (manual/automated) pass identically

**Todo List**
1. Extract a shared `executeRAGQuery({ query, pipelineCfg, sourceFilter, topK, minScore })` function that returns `{ answer, faithfulnessScore, relevanceScore, latencyMs, topResults }` 
2. Replace the body of `POST /api/query` with a call to `executeRAGQuery` + log write
3. Replace the body of `POST /api/agent/query` with a call to `executeRAGQuery` + key-scoped source filtering + log write with agent tag
4. Verify both endpoints return identical shapes where expected

**Relevant Context**
- `server.ts` lines 757–900: `/api/query` implementation
- `server.ts` lines 1232–1396: `/api/agent/query` implementation
- `generateWithOllama()` and `getAI()` are already shared utilities; follow the same pattern

---

### ST-5 — Fix Dashboard: Wire Real Metrics, Remove Hardcoded Mocks

**Status**: `[ ] pending`

**Severity**: 🔴 BLOCKER (data accuracy)

**Intent**  
The Analytics Dashboard currently displays entirely fabricated numbers — `99.9% uptime`, `240ms avg latency`, `94.2% faithfulness`, `1,248,502 vectors`, `4.2 TB storage`, `12.4M Pinecone vectors`. Users in production would make operational and SLA decisions based on these false metrics. The Knowledge Base stats bento cards show the same issues. The "Vector Storage Distribution" chart references Pinecone and Weaviate which are not used.

**Expected Outcomes**
- Dashboard metrics derived from real queryLogs and real source data
- Knowledge Base bento cards show actual source count, actual total vectors from DB
- Playground model display reflects the selected pipeline's actual `generationModel`
- Vector storage chart reflects actual pgvector data only; remove Pinecone/Weaviate references

**Todo List**
1. Add `GET /api/stats` endpoint in `server.ts` that computes and returns: `{ totalVectors, avgLatencyMs, avgFaithfulness, totalLogs, activeSourceCount, syncedSourceCount }` from real data (sum vectorsCount from sources, aggregate from queryLogs)
2. Add `stats` state to `App.tsx`, fetch on mount alongside existing data
3. Replace all hardcoded numbers in `dashboard` tab with real values from `stats` and `sources` state
4. Replace hardcoded numbers in `knowledge-base` bento cards (Total Indexed Vectors, QPM, Storage)
5. Replace Pinecone/Weaviate chart with an actual pgvector storage indicator showing real total vector count from `stats.totalVectors`
6. Fix Playground model display: derive from `pipelines.find(p => p.name === playgroundPipeline)?.generationModel`
7. Fix embedding model display in Workspace Config: show actual `embeddingModel` from config, not hardcoded `"nomic-embed-text:latest"`

**Relevant Context**
- `src/App.tsx` lines 1253–1293: KB bento cards (hardcoded)
- `src/App.tsx` lines 1880–1965: Dashboard metric cards (hardcoded)
- `src/App.tsx` lines 2039–2057: Vector distribution chart (hardcoded)
- `src/App.tsx` line 2185: Playground model display (hardcoded)
- `server.ts` line 404: `computePipelineStats()` — can be extended or reused
- `src/db.ts` — can add a `getTotalVectors()` helper

---

### ST-6 — Fix UX: Confirmations, Toast Layout, Dead Links, Loading State

**Status**: `[ ] pending`

**Severity**: 🟠 HIGH (confirmations, loading state) / 🟡 MEDIUM (others)

**Intent**  
Multiple UX issues make the app feel unfinished or untrustworthy for handoff: destructive operations have no confirmation, the toast notification renders icon and text without flex alignment, several UI controls are dead (global search bar, notification bell, Help System link), and the app renders an empty screen for several seconds on load with no loading indicator.

**Problem Detail**
- No confirmation before: delete document, delete user, delete pipeline, revoke API key
- Toast layout: icon and text not in a flex container → renders stacked
- Global header search bar (`searchQuery` state set but never used)
- Notification bell shows hardcoded toast "Database synchronization online."
- "Help System" sidebar link is `href="#"` — navigates nowhere
- "Remind team now" security alert link is `href="#"`
- No loading skeleton or spinner during initial data fetch
- User role cannot be edited after creation (no edit button, no PATCH endpoint)
- Source "Pause/Resume" has no backend route or UI button

**Expected Outcomes**
- All destructive actions require a confirmation modal before executing
- Toast renders icon and text in a `flex items-center gap-2` container
- Global search bar either functional (searches within current tab) or removed
- Notification bell removed or replaced with real system alerts (health check failures, embed errors)
- Help System link points to README.md or opens a documentation panel
- "Remind team now" removed (mock) or replaced with a real action stub
- Initial data load shows a centered spinner/skeleton
- User role is editable inline via dropdown; `PATCH /api/users/:id` added to backend
- Pause/Resume source button added with backend `PATCH /api/sources/:id/status` route

**Todo List**
1. Build a reusable `ConfirmModal` component (`title`, `message`, `onConfirm`, `onCancel`)
2. Wrap delete source, delete user, delete pipeline, and revoke key handlers with the modal
3. Fix toast container: add `flex items-center gap-2` wrapper around icon + text
4. Add initial loading state: `isAppLoading` state, show centered `<RefreshCw className="animate-spin" />` while `loadData()` is in progress
5. Remove global search bar from header, or scope it to filter the active tab's visible list
6. Replace notification bell with a computed alert count based on: sources with "Auth Error" status, Ollama/pgvector connectivity failures
7. Change Help System link to `href="/README.md"` target `_blank` or render a simple help drawer
8. Remove "Remind team now" dead link; replace paragraph with static advisory text
9. Add inline role editor to user table row: a `<select>` shown on hover, calling `PATCH /api/users/:id`
10. Add `PATCH /api/users/:id` route to `server.ts`
11. Add Pause/Resume button in Knowledge Base source table
12. Add `PATCH /api/sources/:id/status` route to `server.ts` (accepts `{ status: "Paused" | "Synced" }`)

**Relevant Context**
- `src/App.tsx` lines 600–619: Toast component (fix layout here)
- `src/App.tsx` lines 217–244: `loadData()` and `useEffect` mount hook (add loading state)
- `src/App.tsx` lines 773–784: Global search bar (dead state)
- `src/App.tsx` lines 810–816: Notification bell
- `src/App.tsx` lines 733–735: Help System link
- `src/App.tsx` lines 1550–1558, 697–699, 2021–2026, ~2540: Delete handlers without confirmation
- `server.ts` lines 933–960: User management routes (add PATCH)

---

### ST-7 — Knowledge Base: Pagination, Server-Side Search, Chunk Preview

**Status**: `[ ] pending`

**Severity**: 🟠 HIGH

**Intent**  
The Knowledge Base table currently fetches all sources to the client and filters them in JavaScript by searching `doc.content` — a field that could be megabytes of text per source. With 50+ sources this becomes a browser freeze. The pagination buttons are hardcoded as `disabled`. Additionally, there is no way to inspect what was actually indexed in pgvector — users cannot verify chunk quality before deploying a pipeline.

**Expected Outcomes**
- Knowledge Base table uses server-side pagination and search
- Pagination buttons are functional with configurable page size (default 20)
- Search filters by `name` and `type` server-side, not by raw `content`
- A "Preview Chunks" action on each source row opens a modal showing the first N chunks from pgvector
- Source document `name` or `type` is editable

**Todo List**
1. Add query params to `GET /api/sources`: `?search=<term>&limit=20&offset=0` in `server.ts`
2. Add `GET /api/sources/:id/chunks?limit=10` endpoint in `server.ts`; add `loadChunksBySource(sourceId, limit)` to `src/db.ts`
3. Update `filteredSources` in `App.tsx` to use server-side pagination instead of client-side content search
4. Add `currentPage`, `pageSize`, `totalSources` state to `App.tsx`
5. Wire pagination prev/next buttons to update `offset` and re-fetch
6. Add "Preview Chunks" button to source table row actions
7. Build chunk preview drawer/modal showing chunk text, token count, and similarity score range
8. Add `PATCH /api/sources/:id` endpoint for renaming/updating source metadata

**Relevant Context**
- `src/App.tsx` lines 600–606: `filteredSources` — searches `doc.content` client-side
- `src/App.tsx` lines 1571–1576: Disabled pagination buttons
- `src/db.ts` — add `loadChunksBySource()` helper
- `server.ts` line 532: `GET /api/sources` — extend with pagination/search params

---

### ST-8 — Observability: Request Logging, Graceful Shutdown, Health Check Fix

**Status**: `[ ] pending`

**Severity**: 🟠 HIGH

**Intent**  
Without HTTP request logging, it is impossible to diagnose performance issues, trace errors, or audit API access. Without a graceful shutdown handler, in-flight requests and SSE streams are dropped abruptly on every deploy. The health check endpoint always returns `200 OK` even when critical dependencies (pgvector, Ollama) are offline — Kubernetes and load balancers will route traffic to broken instances indefinitely.

**Expected Outcomes**
- Every HTTP request logged with method, path, status code, and latency
- SIGTERM/SIGINT triggers graceful shutdown: stop accepting connections, await in-flight requests, close DB pool
- `/api/health` returns HTTP `503` when pgvector or Ollama is unreachable, `200` when both are connected

**Todo List**
1. Install `morgan`; add `app.use(morgan("combined"))` or `morgan("dev")` before routes
2. Add SIGTERM/SIGINT handler that calls `server.close()` then `pool.end()` then `process.exit(0)`; export `httpServer` from `startServer()`
3. Fix `/api/health`: return `res.status(pgConnected && ollamaConnected ? 200 : 503).json({ status: pgConnected && ollamaConnected ? "healthy" : "unhealthy", ... })`
4. Add a 30-second force-kill timeout in the shutdown handler in case connections stall

**Relevant Context**
- `server.ts` lines 506–529: `/api/health` implementation
- `server.ts` lines 1412–1420: `startServer()` and `app.listen()` — refactor to expose `httpServer`
- `src/db.ts` line 15: `getPool()` — expose a `closePool()` function for shutdown handler

---

### ST-9 — Query Logs: Pagination API, Filtering, Export, Timestamp Fix

**Status**: `[ ] pending`

**Severity**: 🟠 HIGH

**Intent**  
The `/api/logs` endpoint returns the entire unbounded in-memory array on every call. As query volume grows this response balloons to hundreds of megabytes. Logs have no filtering, no search, and no export capability. Timestamps are stored as `"14:22:18"` (time only, no date) making cross-day sorting and date-range filtering impossible.

**Expected Outcomes**
- `GET /api/logs` supports pagination: `?limit=50&offset=0&pipeline=<name>&status=<success|warning|error>&search=<text>`
- Log timestamps stored as full ISO 8601 strings
- Log export: `GET /api/logs/export?format=csv` or `?format=json` returns a downloadable file
- Dashboard query log section displays paginated logs with filter controls
- Log count badge shown in Dashboard tab header

**Todo List**
1. Fix timestamp generation in `server.ts`: change `new Date().toLocaleTimeString(...)` to `new Date().toISOString()` everywhere a new log is created
2. Migrate existing seed logs to ISO timestamps
3. Add query params to `GET /api/logs`: limit, offset, pipeline, status, search (searches `query` field)
4. Add `GET /api/logs/export` endpoint returning `Content-Disposition: attachment` with CSV or JSON body
5. Add filter controls to Dashboard query log section in `App.tsx`: pipeline dropdown, status filter buttons, search input, date range picker (or quick-select: Last 24h / 7d / 30d)
6. Add "Export Logs" button with format selector
7. Wire pagination to log list; show total count

**Relevant Context**
- `server.ts` lines 431–474: seed log data (fix timestamps)
- `server.ts` line 887: `timestamp: new Date().toLocaleTimeString(...)` — fix to `.toISOString()`
- `server.ts` line 898: `queryLogs.unshift(newLog)` — after ST-1, this also writes to DB
- `src/App.tsx` lines 2061–2100: Query log display section (add filters, pagination, export button)
- `src/types.ts` line 26: `timestamp: string` — add JSDoc noting ISO 8601 format

---

### ST-10 — Embedding Reliability: Retry Logic, Queue, and Truncation Warning

**Status**: `[ ] pending`

**Severity**: 🟡 MEDIUM

**Intent**  
The embedding pipeline has no retry logic — a single Ollama network hiccup fails the entire document import. The sequential one-at-a-time embedding of chunks is unnecessarily slow; a semaphore-limited concurrency pool would reduce indexing time significantly. The 2000-character truncation cap silently degrades retrieval quality for long documents without any user warning.

**Expected Outcomes**
- `embedText()` retries up to 3 times with exponential backoff before throwing
- `embedAndStoreChunks()` embeds chunks with configurable concurrency (default: 3 at a time)
- The "Index New Document" form shows a warning when document content exceeds N characters per chunk
- `sanitizeText()` applied to chunk text before embedding call (currently inconsistent)

**Todo List**
1. Add `embedTextWithRetry(text, maxRetries=3)` wrapper in `src/embeddings.ts` with exponential backoff (1s, 2s, 4s)
2. Update all `embedText()` callers in `server.ts` to use `embedTextWithRetry()`
3. Replace sequential loop in `embedAndStoreChunks()` with a semaphore-limited `Promise.all` (concurrency = 3)
4. In `src/embeddings.ts`, sanitize text via `sanitizeForEmbed()` before the Ollama call; apply same sanitization in `embedAndStoreChunks()` before passing to embed
5. In the "Index New Document" form (`App.tsx`), after PDF parse or text paste, compute estimated chunks from `chunkSize` config and show an inline note if any chunk exceeds `MAX_CHARS * 0.8` characters

**Relevant Context**
- `src/embeddings.ts` lines 31–39: `sanitizeForEmbed()` — already exists but not used in `embedAndStoreChunks`
- `src/embeddings.ts` lines 47–64: `embedText()` — add retry wrapper here
- `server.ts` lines 537–566: `embedAndStoreChunks()` — add concurrency here
- `server.ts` lines 224–232: seed embedding loop — update to use retry

---

### ST-11 — Type Safety: Separate AgentApiKeyPublic, Fix QueryLog Interface

**Status**: `[ ] pending`

**Severity**: 🟡 MEDIUM

**Intent**  
The `AgentApiKey` interface in `src/types.ts` includes the `key: string` field (the full secret). This field is in the frontend type system and could be accidentally serialized into logs, analytics payloads, or localStorage. A dedicated `AgentApiKeyPublic` type (no `key` field) and `AgentApiKeyCreated` (with `key`) makes the type system enforce the security boundary. Additionally, the `QueryLog.timestamp` field should be documented/typed as ISO 8601.

**Expected Outcomes**
- `AgentApiKeyPublic` type used in frontend state — no `key` or `_monthStamp` fields
- `AgentApiKeyCreated extends AgentApiKeyPublic` with `key: string` used only in the creation response handler
- `QueryLog.timestamp` documented as ISO 8601 in JSDoc
- Frontend `agentKeys` state uses `AgentApiKeyPublic[]`

**Todo List**
1. Add `AgentApiKeyPublic` interface to `src/types.ts` (all fields except `key` and `_monthStamp`)
2. Add `AgentApiKeyCreated extends AgentApiKeyPublic` with `key: string`
3. Update `agentKeys` state in `App.tsx` to `useState<AgentApiKeyPublic[]>(...)`
4. Update `handleCreateApiKey` to type the creation response as `AgentApiKeyCreated`
5. Add JSDoc to `QueryLog.timestamp` noting ISO 8601 format
6. Run `npx tsc --noEmit` and fix any resulting type errors

**Relevant Context**
- `src/types.ts` lines 66–80: `AgentApiKey` interface
- `src/types.ts` lines 23–34: `QueryLog` interface
- `src/App.tsx` line 147: `agentKeys` useState
- `src/App.tsx` lines 537–570: `handleCreateApiKey`

---

### ST-12 — Add Missing Features: Pipeline Quick-Test, Source Rename, API Versioning Stub

**Status**: `[ ] pending`

**Severity**: 🟡 MEDIUM

**Intent**  
Three high-value features are missing that are needed for handoff-level completeness: (1) ability to quick-test a pipeline configuration without leaving the editor drawer, (2) ability to rename an existing source document, and (3) API route versioning to protect existing agent integrations from future schema changes.

**Expected Outcomes**
- Pipeline editor drawer has a "Test Query" inline input + execute button that runs a single query against the current form state without saving
- Source table "Rename" action edits the source name inline with a save button
- All routes available at both `/api/...` (legacy, maintained for compatibility) and `/api/v1/...` (canonical going forward)

**Todo List**
1. Add `PATCH /api/sources/:id` route to `server.ts` accepting `{ name?: string, type?: string }` and updating DB
2. Add inline rename UI to Knowledge Base source table row (pencil icon → inline input)
3. Add "Test Query" section to Pipeline Editor drawer: `testQuery` input, run button, shows mini result (answer excerpt + scores) without saving
4. The test query should call `POST /api/query` (or the shared `executeRAGQuery` from ST-4) with the current draft pipeline form, returning results without writing a full log entry
5. Add an Express `Router` at `/api/v1` that mirrors all existing routes; keep `/api` routes as aliases; update README

**Relevant Context**
- `src/App.tsx` lines 2367–2550: Pipeline Editor Drawer — add test section to form body
- `server.ts` lines 640–652: `DELETE /api/sources/:id` — add `PATCH` alongside
- `server.ts` lines 532–534: `GET /api/sources` — add `PATCH /api/sources/:id`

---

## Dependency Order

Some sub-tasks should be done before others:

```
ST-1 (DB Persistence)  ──►  ST-4 (Code Dedup)  ──►  ST-9 (Log Pagination)
ST-2 (Admin Auth)
ST-3 (CORS/Security)
ST-5 (Real Metrics)    ──►  ST-1 (needs /api/stats from real data)
ST-6 (UX Fixes)
ST-7 (KB Pagination)
ST-8 (Observability)
ST-10 (Embedding)
ST-11 (Types)          ──►  most other tasks (do early)
ST-12 (Missing Features)
```

**Recommended implementation order:**
1. ST-11 (Types — no-risk, enables type safety for everything else)
2. ST-2 (Security — critical, no dependencies)
3. ST-3 (CORS/Security — critical, no dependencies)
4. ST-8 (Observability — needed before load testing anything else)
5. ST-1 (DB Persistence — foundation for ST-4, ST-5, ST-9)
6. ST-4 (Code Dedup — enables consistent ST-5, ST-9 fixes)
7. ST-5 (Real Metrics — depends on ST-1 + ST-4)
8. ST-9 (Log Pagination — depends on ST-1 + ST-4)
9. ST-6 (UX Fixes — independent, high visibility)
10. ST-7 (KB Pagination — independent)
11. ST-10 (Embedding Reliability)
12. ST-12 (Missing Features — last, additive)
