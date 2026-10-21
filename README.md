# MarmotRAG — Knowledge Chunking & Retrieval Service

MarmotRAG is a multi-user, shareable **knowledge retrieval service** — not a full RAG system. The "G" (generation) has been deliberately removed: the service never composes an answer. It runs a three-stage pipeline and exposes the result over HTTP:

1. **Chunk** — uploaded documents (PDF / plain text) are split into pieces using Semantic, Fixed, or Recursive strategies.
2. **Embed** — each chunk is vectorized locally via Ollama (`qwen3-embedding:4b`).
3. **Retrieve** — callers query the vector store through the API and get back the most relevant chunks with similarity scores.

Both stages are exposed as API-key-protected endpoints, so external applications (e.g. an agentic app) can **store** memory snippets and later **fetch** the relevant chunks:

- `POST /api/agent/sources` — ingest new content; the server chunks + embeds + stores it.
- `POST /api/agent/retrieve` — fetch the most relevant stored chunks for a query.

Callers bring their own LLM (or any downstream logic) if they want to generate answers from the retrieved chunks; that step happens entirely outside MarmotRAG.

---

## 1. Features

| Category | Capability |
|---|---|
| **Multi-user** | Demo identity via `X-User-Id` (session/JWT-ready); every user sees only their own + shared documents |
| **Document management** | PDF / TXT / DOCX upload (auto text extraction), plain-text paste, 50 MB limit, re-index, pause, rename, delete, chunk preview |
| **Sharing** | Per-document private/shared toggle — shared documents are visible to every user and every API key |
| **Chunking** | Three strategies: Semantic, Fixed, Recursive — CJK-aware via `jieba-wasm`; global config (size/overlap) |
| **Embedding** | Pluggable embedding backend — Ollama native or OpenAI-compatible (LM Studio / vLLM / OpenAI); any model with ≥2000 dims, truncated to 2000 |
| **Vector Store** | PostgreSQL + `pgvector` with HNSW cosine index |
| **Ingestion API** | `POST /api/agent/sources` stores a memory/document (create-only, idempotency guard via optional `id`) |
| **Retrieval API** | `POST /api/agent/retrieve` returns chunks + scores (chunk retrieval only — no generation) |
| **API Keys** | Per-user keys with `X-API-Key` auth, rate limiting, usage counters, per-key source scoping |
| **Observability** | Retrieval query log with latency and retrieved chunks; dashboard stats |

## 2. Architecture

```
Pipeline: Document → Chunk → Embed → Store (pgvector) → Retrieve via API
```

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
| Ollama (or an OpenAI-compatible embeddings server, e.g. LM Studio / vLLM) | latest | Embedding backend — see §6.1 |
| `qwen3-embedding:4b` | — | Default 2560-dim Matryoshka embedding (truncated to 2000) |

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
| `OLLAMA_EMBED_MODEL` | `qwen3-embedding:4b` | No | Ollama embedding model name (must exist locally) |
| `EMBED_API` | `ollama` | No | Wire protocol of the embedding server: `ollama` or `openai` (LM Studio / vLLM / OpenAI-compatible) |
| `EMBED_BASE_URL` | — | No | Overrides `OLLAMA_BASE_URL`; for OpenAI-compatible servers include the version prefix (e.g. `http://localhost:1234/v1`) |
| `EMBED_API_KEY` | — | No | Bearer token, only used when `EMBED_API=openai` |
| `PORT` | `3000` | No | HTTP port |
| `CORS_ORIGINS` | `*` | No | Allowed origins (comma-separated) |

### 6.1 Embedding backend

The embedding client speaks either the **Ollama native protocol** or the **OpenAI-compatible protocol**. `EMBED_API` selects which one; `GET /api/config` always reports what is actually in use.

| | `EMBED_API="ollama"` (default) | `EMBED_API="openai"` |
|---|---|---|
| Request | `POST {base}/api/embeddings` · `{model, prompt}` | `POST {base}/embeddings` · `{model, input}` |
| Response field | `embedding` | `data[0].embedding` |
| Health probe | `GET {base}/api/tags` | `GET {base}/models` |
| Base URL example | `http://localhost:11434` | `http://localhost:1234/v1` |
| Auth | none | optional `EMBED_API_KEY` (Bearer) |

**Ollama (default)**

```dotenv
OLLAMA_BASE_URL="http://localhost:11434"
OLLAMA_EMBED_MODEL="qwen3-embedding:4b"
EMBED_API="ollama"
```

**LM Studio / vLLM / OpenAI-compatible** (example: `Qwen/Qwen3-Embedding-4B-GGUF`)

```dotenv
EMBED_API="openai"
EMBED_BASE_URL="http://localhost:1234/v1"
OLLAMA_EMBED_MODEL="Qwen/Qwen3-Embedding-4B-GGUF"
# EMBED_API_KEY="sk-..."   # only if the server requires a bearer token
```

Notes:

- For OpenAI-compatible servers the base URL must include the version prefix (`/v1`) — the client appends `/embeddings`.
- `OLLAMA_EMBED_MODEL` must match the model id the server reports (`GET {base}/models`); LM Studio sometimes exposes a simplified id.
- Only the **first 2000 dimensions** are stored (pgvector HNSW/ivfflat index limit), so any embedding model with ≥2000 dims works.
- `.env` is loaded **once at startup** — restart the server after editing it. (The values themselves are read at call time, but the file is only read on boot.)

Verify the configuration:

```bash
# OpenAI-compatible server: list model ids, then embed a test string
curl http://localhost:1234/v1/models
curl -X POST http://localhost:1234/v1/embeddings \
  -H "Content-Type: application/json" \
  -d '{"model":"Qwen/Qwen3-Embedding-4B-GGUF","input":"test"}'

# Ollama: check the model is pulled
ollama list

# App side: health probe + effective embedding settings
curl -H "X-User-Id: u-1" http://localhost:3000/api/health   # ollamaConnected: true
curl -H "X-User-Id: u-1" http://localhost:3000/api/config   # embeddingModel / ollamaBaseUrl / embeddingProvider
```

`POST /api/config` intentionally ignores `embeddingModel`, `ollamaBaseUrl` and `embeddingProvider` — those are environment-owned, so the dashboard can never display a value that disagrees with the running embedding client.

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
| `POST` | `/api/parse-document` | Extract text from Base64 PDF / TXT / DOCX (`base64` + `filename`) |
| `POST` | `/api/retrieve` | Retrieve chunks (Playground, no generation) |
| `GET/POST` | `/api/config` | Global chunking config |
| `GET` | `/api/stats` | Dashboard stats for current user |
| `GET` | `/api/logs` · `/api/logs/export` | Query log for current user |
| `GET/POST/PATCH/DELETE` | `/api/users` | Demo user management |
| `GET/POST/PATCH/DELETE` | `/api/agent/keys` | Current user's API keys |

### 8.2 Agent API (external, `X-API-Key`)

There are two public endpoints, both authenticated with `X-API-Key`; everything else in the system is dashboard-internal and not exposed to external callers.

**Ingest** — store new content (create-only). The server chunks, embeds, and stores it as a private source owned by the key's user:

```bash
curl -X POST http://localhost:3000/api/agent/sources \
  -H "X-API-Key: mrmk_..." \
  -H "Content-Type: application/json" \
  -d '{
    "id": "mem-user-pref-001",
    "name": "User preference: concise replies",
    "content": "The user mentioned they prefer short, direct answers."
  }'
```

Response:

```json
{
  "sourceId": "mem-user-pref-001",
  "name": "User preference: concise replies",
  "chunkCount": 1,
  "status": "Synced",
  "sourceFilterUpdated": false
}
```

Ingest rules:

- `content` is required (max 50,000 characters); `name` and `type` are optional.
- The optional `id` is a **create-only idempotency guard**: re-sending an existing `id` returns `409` instead of overwriting.
- Writes are **never updated or deleted through the Agent API** — managing knowledge (rename / share / pause / re-index / delete) is the owner's job and stays in the dashboard (owner-only).
- The new source is added to the writing key's `sourceFilter`, so that key can always retrieve what it stored.

**Retrieve** — fetch the most relevant chunks for a query:

```bash
curl -X POST http://localhost:3000/api/agent/retrieve \
  -H "X-API-Key: mrmk_..." \
  -H "Content-Type: application/json" \
  -d '{"query":"2024年示例集团的毛利率是多少？","topK":5,"minScore":0.3}'
```

Response:

```json
{
  "query": "...",
  "chunks": [
    {
      "chunkId": "src-...-chk-0",
      "sourceId": "src-...",
      "sourceName": "EXAMPLE_ESG2024_tw",
      "text": "...",
      "score": 0.82,
      "tokenCount": 128
    }
  ],
  "context": "[Document 1: EXAMPLE_ESG2024_tw]\n...",
  "latencyMs": 245
}
```

**Scoping:** a key can only retrieve from its owner's documents plus platform-shared documents, intersected with the key's `sourceFilter`. Keys are rate-limited per minute; usage is counted and logged under the owning user.

### 8.3 Error Reference

| Code | Meaning |
|---|---|
| `401` | Missing / invalid `X-API-Key` |
| `403` | Key disabled, or non-owner mutation |
| `413` | Upload too large (body exceeds the 50 MB document limit) |
| `429` | Rate limit exceeded |
| `500` | Embedding failed — the response includes the reason (endpoint unreachable, model missing, protocol mismatch, …) |

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

### 10.1 Listening address & firewall

`npm start` binds **`0.0.0.0`** (all interfaces) on `PORT` (default `3000`), so it is reachable from other machines as soon as the host firewall allows it.

```powershell
# On the server — confirm the listening socket
netstat -ano | findstr :3000          # expect  0.0.0.0:3000 ... LISTENING

# From a client machine — test reachability
Test-NetConnection -ComputerName <server-ip> -Port 3000

# Allow inbound traffic (elevated PowerShell)
New-NetFirewallRule -DisplayName "MarmotRAG 3000" -Direction Inbound -Protocol TCP -LocalPort 3000 -Action Allow
```

If the app runs behind IIS / nginx, forward the proxy to the same port instead of changing the bind address.

## 11. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `413 {"error":"File too large. Maximum upload size is 50 MB."}` | Upload body exceeded the limit (base64 inflates the payload by ~33%) | Keep files ≤ 50 MB |
| `Embedding failed: ... contained no vector (EMBED_API="ollama")` | Protocol mismatch — the base URL points at an OpenAI-compatible server (e.g. `.../v1`) while `EMBED_API` is still `ollama`, so the client called `/v1/api/embeddings`; the server answered HTTP 200 with an error body | Set `EMBED_API="openai"` (or point the base URL at an Ollama server) and restart — see §6.1 |
| `model "..." not found`, or retrieval returns nothing | `OLLAMA_EMBED_MODEL` doesn't match the server's model id | Check `GET {base}/models` (OpenAI-compatible) or `ollama list` |
| `ollamaConnected: false` although the model server is running | Wrong base URL, wrong protocol (the health probe uses `/api/tags` vs `/models`), or a firewall | Verify base URL + `EMBED_API`; see §6.1 |
| Environment changes have no effect | `.env` is read only at startup, or the process runs from a different working directory (e.g. a service manager with a different cwd) so no `.env` was found | Restart the process; the startup log must show `injected env (N) from .env` |
| Service unreachable from another machine | Windows Firewall blocks the port | See §10.1 |
| Vectors disappeared after a restart | Older builds recreated `marmot_chunks` when the embedding column typmod didn't match (fixed) | Update to the current version; re-index the affected sources |

## 12. Roadmap Seams

- Replace `createResolveUser` with session/JWT middleware for real authentication.
- Upgrade `is_shared` boolean to `shared_with` lists for fine-grained sharing.
- Add hybrid (BM25 + vector) retrieval or reranking in `retrieveCore`.
- Store PDF page metadata on chunks for page-level citations.
