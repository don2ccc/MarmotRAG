# Marmot RAG — Enterprise Knowledge Retrieval Service

Marmot RAG is a multi-user, shareable **retrieval service**: users upload and manage their own documents, choose whether to share each document with the platform, and expose their knowledge through API keys so other applications can retrieve relevant chunks over HTTP.

**Retrieval only — no answer generation.** The service returns the most relevant chunks (with scores) for a query; callers bring their own LLM if they want to generate answers from the retrieved context.

---

## 1. Features

| Category | Capability |
|---|---|
| **Multi-user** | Demo identity via `X-User-Id` (session/JWT-ready); every user sees only their own + shared documents |
| **Document management** | PDF upload (text extraction via `pdf-parse`), plain-text paste, 50 MB limit, re-index, pause, rename, delete, chunk preview |
| **Sharing** | Per-document private/shared toggle — shared documents are visible to every user and every API key |
| **Chunking** | Three strategies: Semantic, Fixed, Recursive — CJK-aware via `jieba-wasm`; global config (size/overlap) |
| **Embedding** | Local Ollama (`qwen3-embedding:4b`, 2000-dim, Matryoshka truncation) |
| **Vector Store** | PostgreSQL + `pgvector` with HNSW cosine index |
| **Retrieval API** | `POST /api/agent/retrieve` returns chunks + scores + pre-assembled context |
| **API Keys** | Per-user keys with `X-API-Key` auth, rate limiting, usage counters, per-key source scoping |
| **Observability** | Retrieval query log with latency and retrieved chunks; dashboard stats |

## 2. Architecture

```
Browser SPA (React)                    External apps
      │  X-User-Id (demo)                   │  X-API-Key
      ▼                                     ▼
          Express Server (server.ts)
   ├── src/auth.ts       user resolution + agent key auth
   ├── src/retrieval.ts  chunkText + retrieveCore (embed → search → filter → topK)
   ├── src/db.ts         pgvector store + persistence
   └── src/embeddings.ts Ollama embedding wrapper
                 │
      PostgreSQL + pgvector (marmot_chunks / marmot_sources / ...)
```

**Visibility rule (enforced in every retrieval):**

```
visible = (source.owner_id = current user) OR (source.is_shared = TRUE)
```

Only `Synced` sources are searchable. Mutations (rename, share, pause, re-index, delete) are owner-only (403 otherwise).

## 3. Repository Structure

```
MarmotRAG/
├── server.ts              # Express bootstrap, middleware, seed + startup
├── src/
│   ├── auth.ts            # createResolveUser (X-User-Id), createAgentAuth (X-API-Key)
│   ├── retrieval.ts       # chunkText, retrieveCore
│   ├── db.ts              # schema/migrations + persistence helpers
│   ├── embeddings.ts      # Ollama qwen3-embedding:4b wrapper (retry, concurrency)
│   ├── store.ts           # in-memory runtime state (loaded from DB)
│   ├── routes/            # sources.ts · agent.ts · system.ts
│   ├── tabs/              # one React component per dashboard tab
│   ├── components/        # UserSwitcher
│   ├── api.ts             # fetch wrapper (X-User-Id)
│   └── types.ts           # shared TypeScript types
├── scripts/test-retrieval.mjs  # integration test
└── testdata/              # sample PDF
```

## 4. Prerequisites

| Requirement | Version | Purpose |
|---|---|---|
| Node.js | ≥ 18 | Runtime |
| PostgreSQL | ≥ 14 | Vector store host |
| pgvector | ≥ 0.5 | `CREATE EXTENSION vector` |
| Ollama | latest | Local embedding model |
| `qwen3-embedding:4b` | — | 2560-dim Matryoshka embedding (truncated to 2000) |

```bash
ollama pull qwen3-embedding:4b
```

```sql
CREATE DATABASE ai_hub;
\c ai_hub
CREATE EXTENSION IF NOT EXISTS vector;
```

All `marmot_*` tables and idempotent migrations are created automatically on first server start.

## 5. Local Development

```bash
npm install
cp .env.example .env   # fill in PG_PASSWORD
npm run dev            # http://localhost:3000
```

First boot seeds demo users (u-1 Jane Doe, u-2 Marcus Kane, u-3 Sarah Lim), demo sources, and one demo agent key (`mrmk_demo_...0000`). Use the **user switcher** in the sidebar to change the active user.

## 6. Environment Variables

| Variable | Default | Required | Description |
|---|---|---|---|
| `PG_HOST` | `127.0.0.1` | Yes | PostgreSQL host |
| `PG_PORT` | `5432` | Yes | PostgreSQL port |
| `PG_USER` | `postgres` | Yes | PostgreSQL user |
| `PG_PASSWORD` | — | Yes | PostgreSQL password |
| `PG_DATABASE` | `ai_hub` | Yes | Database name |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Yes | Ollama API base URL |
| `PORT` | `3000` | No | HTTP port |
| `CORS_ORIGINS` | `*` | No | Allowed origins (comma-separated) |

## 7. Dashboard Tabs

- **Dashboard** — pgvector/Ollama health, retrieval stats, paginated query log with expandable chunks.
- **Knowledge Base** — add (text/PDF), share toggle, re-index, pause, rename, delete, chunk preview. Shared documents appear read-only with a `Shared · <owner>` badge.
- **Retrieval Lab** — query with `topK` / `minScore`, see scored chunks and the pre-assembled context.
- **Agent API** — create per-user API keys (label, rate limit, optional source scope), one-time secret reveal, usage cards, inline API reference.
- **Workspace** — global chunking config (chunk size / overlap / strategy), pgvector & Ollama info.
- **Users** — demo user management for the switcher (SSO-ready).

## 8. API Reference

### 8.1 Dashboard APIs (same-origin, `X-User-Id` demo header)

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/health` | System health (pgvector + Ollama) |
| `GET` | `/api/sources` | Visible sources (own + shared), paginated |
| `POST` | `/api/sources` | Add & embed a document (SSE progress) |
| `PATCH` | `/api/sources/:id` | Rename / change type / pause / share toggle (owner only) |
| `POST` | `/api/sources/:id/reindex` | Re-chunk and re-embed (owner only, SSE) |
| `DELETE` | `/api/sources/:id` | Delete source + vectors (owner only) |
| `GET` | `/api/sources/:id/chunks` | Chunk preview (visible sources) |
| `POST` | `/api/parse-pdf` | Extract text from Base64 PDF |
| `POST` | `/api/retrieve` | Retrieve chunks (Playground) |
| `GET/POST` | `/api/config` | Global chunking config |
| `GET` | `/api/stats` | Dashboard stats for current user |
| `GET` | `/api/logs` · `/api/logs/export` | Query log for current user |
| `GET/POST/PATCH/DELETE` | `/api/users` | Demo user management |
| `GET/POST/PATCH/DELETE` | `/api/agent/keys` | Current user's API keys |

### 8.2 Agent API (external, `X-API-Key`)

**The only public endpoint is `POST /api/agent/retrieve`** — everything else in the system is dashboard-internal and not exposed to external callers.

```bash
curl -X POST http://localhost:3000/api/agent/retrieve \
  -H "X-API-Key: mrmk_..." \
  -H "Content-Type: application/json" \
  -d '{"query":"2024年国巨集团的毛利率是多少？","topK":5,"minScore":0.3}'
```

Response:

```json
{
  "query": "...",
  "chunks": [
    {
      "chunkId": "src-...-chk-0",
      "sourceId": "src-...",
      "sourceName": "YAGEO_ESG2024_tw",
      "text": "...",
      "score": 0.82,
      "tokenCount": 128
    }
  ],
  "context": "[Document 1: YAGEO_ESG2024_tw]\n...",
  "latencyMs": 245
}
```

**Scoping:** a key can only retrieve from its owner's documents plus platform-shared documents, intersected with the key's `sourceFilter`. Keys are rate-limited per minute; usage is counted and logged under the owning user.

### 8.3 Error Reference

| Code | Meaning |
|---|---|
| `401` | Missing / invalid `X-API-Key` |
| `403` | Key disabled, or non-owner mutation |
| `429` | Rate limit exceeded |
| `500` | Embedding failed (Ollama not running / model missing) |

## 9. Testing

```bash
npm run lint          # tsc --noEmit
npm run build         # vite build + esbuild server bundle
npm test              # integration test (requires running server + Ollama)
```

`npm test` verifies user isolation, share toggling, owner-only 403s, and API key scoping, then cleans up after itself.

## 10. Build for Production

```bash
npm run build
NODE_ENV=production npm start
```

## 11. Roadmap Seams

- Replace `createResolveUser` with session/JWT middleware for real authentication.
- Upgrade `is_shared` boolean to `shared_with` lists for fine-grained sharing.
- Add hybrid (BM25 + vector) retrieval or reranking in `retrieveCore`.
- Store PDF page metadata on chunks for page-level citations.
