# Marmot RAG — Enterprise Knowledge Retrieval Platform

Marmot RAG is a production-grade, full-stack **Retrieval-Augmented Generation (RAG)** management platform. It provides real-time document ingestion, multilingual chunking & embedding, pipeline-based query orchestration, a visual analytics dashboard, and a complete **Agent API** that allows external AI systems (LangChain, LlamaIndex, custom bots) to retrieve grounded knowledge over HTTP.

---

## Table of Contents

1. [Feature Overview](#1-feature-overview)
2. [Architecture](#2-architecture)
3. [Repository Structure](#3-repository-structure)
4. [Prerequisites](#4-prerequisites)
5. [Local Development Setup](#5-local-development-setup)
6. [Environment Variables](#6-environment-variables)
7. [Frontend — Tab Reference](#7-frontend--tab-reference)
8. [Backend — API Reference](#8-backend--api-reference)
   - [Internal Dashboard APIs](#81-internal-dashboard-apis)
   - [Agent API (External Integration)](#82-agent-api-external-integration)
9. [Agent API — Integration Guide](#9-agent-api--integration-guide)
   - [Authentication](#91-authentication)
   - [POST /api/agent/query](#92-post-apiagentquery)
   - [POST /api/agent/retrieve](#93-post-apiagentretrieve)
   - [GET /api/agent/sources](#94-get-apiagentsources)
   - [Error Reference](#95-error-reference)
   - [Python Example (LangChain-style)](#96-python-example-langchain-style)
   - [curl Examples](#97-curl-examples)
10. [RAG Pipeline System](#10-rag-pipeline-system)
11. [Chunking & Embedding](#11-chunking--embedding)
12. [User & Access Management](#12-user--access-management)
13. [Build for Production](#13-build-for-production)
14. [Developer Guide](#14-developer-guide)

---

## 1. Feature Overview

| Category | Capability |
|---|---|
| **Ingestion** | PDF upload (text extraction via `pdf-parse`), plain text paste, 50 MB limit |
| **Chunking** | Three strategies: Semantic, Fixed, Recursive — CJK-aware via `jieba-wasm` |
| **Embedding** | Local Ollama (`qwen3-embedding:4b`, 2000-dim, Matryoshka truncation) |
| **Vector Store** | PostgreSQL + `pgvector` with HNSW cosine index |
| **Pipelines** | Named, configurable RAG pipelines — model, topK, minScore, system prompt, source filter |
| **Generation** | Gemini cloud (`gemini-3.5-flash`, `gemini-1.5-pro`) or local Ollama LLM |
| **Playground** | Visual step-by-step retrieval trace — chunks, scores, grounded answer |
| **Dashboard** | Query logs, pipeline latency, faithfulness scores, storage distribution |
| **Agent API** | REST API for external agents — `X-API-Key` auth, rate limiting, per-key scoping |
| **Admin** | User management (mock, SSO-ready), provider config, SSO toggle |
| **Theming** | Light / Dark toggle, Neon-Green dark theme |

---

## 2. Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Browser (React SPA)                   │
│  Dashboard │ Knowledge Base │ Playground │ Agent Access  │
└──────────────────────┬──────────────────────────────────┘
                       │ HTTP (same origin, port 3000)
┌──────────────────────▼──────────────────────────────────┐
│              Express Server  (server.ts)                 │
│                                                          │
│  ┌─────────────────┐   ┌──────────────────────────────┐ │
│  │  Dashboard APIs │   │  Agent API  (/api/agent/*)   │ │
│  │  /api/sources   │   │  X-API-Key middleware         │ │
│  │  /api/pipelines │   │  Rate limiter (per-key)       │ │
│  │  /api/query     │   │  Usage counter               │ │
│  │  /api/logs      │   └──────────────────────────────┘ │
│  └─────────────────┘                                     │
│                                                          │
│  ┌─────────────┐   ┌──────────┐   ┌───────────────────┐ │
│  │  pdf-parse  │   │ jieba-   │   │  embedText()      │ │
│  │  (PDF text) │   │ wasm     │   │  → Ollama embed   │ │
│  └─────────────┘   │ (tokens) │   └───────────────────┘ │
│                    └──────────┘                          │
└──────────────────────┬──────────────────────────────────┘
                       │
        ┌──────────────┴──────────────┐
        │                             │
┌───────▼────────┐          ┌─────────▼──────────┐
│  PostgreSQL    │          │  Ollama / Gemini    │
│  + pgvector    │          │  (local or cloud)   │
│  HNSW index    │          │  Embedding + LLM    │
│  2000-dim      │          └────────────────────┘
└────────────────┘
```

**Data flow for an Agent query:**
1. Agent sends `POST /api/agent/query` with `X-API-Key` header
2. `agentAuth` middleware validates the key, checks rate limit, increments usage counters
3. Query text is embedded via Ollama (`qwen3-embedding:4b`)
4. Top-K vectors retrieved from pgvector (cosine similarity)
5. Chunks assembled into a grounded prompt, sent to Gemini / Ollama LLM
6. Structured JSON response returned; query written to system log with `[agent:<label>]` tag

---

## 3. Repository Structure

```
MarmotRAG/
├── server.ts              # Express backend — all API routes, chunking, embedding, Agent API
├── src/
│   ├── App.tsx            # React SPA — all tabs, state, handlers (~2800 lines)
│   ├── types.ts           # Shared TypeScript interfaces (Chunk, Pipeline, AgentApiKey, …)
│   ├── db.ts              # pgvector helpers — initDb, upsertChunk, searchChunks, …
│   ├── embeddings.ts      # Ollama embedding wrapper (qwen3-embedding:4b, 2000-dim)
│   ├── index.css          # Tailwind directives + light/dark theme overrides
│   └── main.tsx           # React entry point
├── index.html             # SPA shell
├── package.json           # Scripts, dependencies
├── tsconfig.json          # TypeScript config
├── vite.config.ts         # Vite + Tailwind plugin
├── .env.example           # Environment variable template
└── README.md              # This file
```

---

## 4. Prerequisites

| Requirement | Version | Purpose |
|---|---|---|
| Node.js | ≥ 18 | Runtime |
| npm | ≥ 9 | Package manager |
| PostgreSQL | ≥ 14 | Vector store host |
| pgvector extension | ≥ 0.5 | `CREATE EXTENSION vector` |
| Ollama | latest | Local embedding model |
| `qwen3-embedding:4b` model | — | 2560-dim Matryoshka embedding (truncated to 2000) |
| Gemini API Key *(optional)* | — | LLM generation; system works offline without it |

### Install Ollama and pull the embedding model

```bash
# Install Ollama (macOS / Linux)
curl -fsSL https://ollama.com/install.sh | sh

# Pull the embedding model used by Marmot RAG
ollama pull qwen3-embedding:4b

# Optional: pull a local generation model (for offline pipelines)
ollama pull bjoernb/gemma4-e4b-think:latest
```

### Create the PostgreSQL database

```sql
CREATE DATABASE ai_hub;
\c ai_hub
CREATE EXTENSION IF NOT EXISTS vector;
```

The tables (`marmot_chunks`, `marmot_sources`) are created automatically on first server start.

---

## 5. Local Development Setup

```bash
# 1. Clone the repository
git clone <repo-url>
cd MarmotRAG

# 2. Install dependencies
npm install

# 3. Configure environment
cp .env.example .env
# Edit .env — fill in PG_PASSWORD, GEMINI_API_KEY (optional), etc.

# 4. Start the dev server (Vite middleware embedded in Express)
npm run dev
```

Open **http://localhost:3000** in your browser.

The first boot seeds the knowledge base with four demo documents and embeds them. This requires Ollama to be running — expect ~30 seconds on first run.

---

## 6. Environment Variables

| Variable | Default | Required | Description |
|---|---|---|---|
| `GEMINI_API_KEY` | — | Optional | Gemini API key for LLM generation. Without it, the system uses Ollama or offline mode. |
| `PG_HOST` | `127.0.0.1` | Yes | PostgreSQL host |
| `PG_PORT` | `5432` | Yes | PostgreSQL port |
| `PG_USER` | `postgres` | Yes | PostgreSQL user |
| `PG_PASSWORD` | — | Yes | PostgreSQL password |
| `PG_DATABASE` | `ai_hub` | Yes | Database name |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Yes | Ollama API base URL |

Copy `.env.example` to `.env` and fill in your values.

---

## 7. Frontend — Tab Reference

The SPA has six tabs (`TabType`), navigable from the left sidebar (desktop) or bottom nav bar (mobile):

### Analytics Dashboard (`dashboard`)
- System health status (pgvector + Ollama + Gemini connectivity)
- Pipeline performance table — latency, faithfulness score, query count
- Vector storage distribution chart
- Expandable query log — shows full grounded answer, retrieved chunks with similarity scores

### Workspace Config (`workspace`)
- Chunk size slider (128 – 2048 tokens)
- Chunk overlap slider (0 – 50%)
- Separation strategy selector: **Semantic** | **Fixed** | **Recursive**
- pgvector connection display (read-only, from `.env`)
- Ollama embedding model display
- Optional external vector DB configuration panel (Pinecone, Weaviate, Qdrant, Milvus, etc. — reserved interface)
- Floating save bar with unsaved-changes detection

### Knowledge Base (`knowledge-base`)
- Add document: paste plain text **or** upload a PDF (auto-extracts text via `/api/parse-pdf`)
- Document type selector (PDF Collection, Notion Webhook, G-Drive Archive, Text Document, API Connector)
- Real-time SSE progress bar during embedding
- Data source table — status badge, last sync time, vector count, owner, re-index / delete actions
- Full-text search filter

### Global Admin (`admin`)
- User workspace management table (add / delete collaborators, mock data)
- SSO Enforcement Policy toggle (reserved interface — connects to Microsoft Entra / Okta)
- Role presets display (Owner, Editor, Compliance, Viewer)
- Global AI provider cards (OpenAI, Azure AI Search, custom)

### RAG Playground (`playground`)
- Free-form query input with pipeline selector
- Execution produces a visual step-by-step trace:
  - **Step 1** — retrieved chunks with source name and cosine score
  - **Step 2** — final grounded LLM response
- Metric cards: Faithfulness Score, Relevance Score, Latency (ms)

### Agent API Access (`api-access`)
- Issue API keys to external AI agents with label, rate limit, bound pipeline, source scope
- One-time secret reveal modal with copy-to-clipboard (key cannot be recovered after closing)
- Key management table — masked preview, usage counters, last-used timestamp, enable/disable/revoke
- Inline API Reference Docs panel with three tabs:
  - `POST /api/agent/query` — full RAG with request/response schema + Python example
  - `POST /api/agent/retrieve` — vector-only retrieval with curl example
  - `GET /api/agent/sources` — source discovery + error code reference
- Usage summary cards — total API calls, this-month calls, active key count

---

## 8. Backend — API Reference

All endpoints are served on `http://localhost:3000`.

### 8.1 Internal Dashboard APIs

These endpoints are called by the React frontend. No authentication required (same-origin).

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/health` | System health — pgvector, Ollama, Gemini connectivity |
| `GET` | `/api/sources` | List all knowledge-base source documents |
| `POST` | `/api/sources` | Add & embed a document (SSE stream with progress events) |
| `DELETE` | `/api/sources/:id` | Delete a source and all its pgvector chunks |
| `POST` | `/api/sources/:id/reindex` | Re-chunk and re-embed an existing source (SSE stream) |
| `POST` | `/api/parse-pdf` | Extract text from a Base64-encoded PDF |
| `GET` | `/api/pipelines` | List all pipelines with live computed stats |
| `POST` | `/api/pipelines` | Create a new pipeline |
| `PUT` | `/api/pipelines/:id` | Update a pipeline |
| `DELETE` | `/api/pipelines/:id` | Delete a pipeline |
| `POST` | `/api/query` | Execute a RAG query (used by Playground tab) |
| `GET` | `/api/logs` | Return all query logs |
| `GET` | `/api/config` | Get current strategy config |
| `POST` | `/api/config` | Update strategy config |
| `GET` | `/api/providers` | List AI provider configurations |
| `POST` | `/api/providers` | Update provider list |
| `GET` | `/api/users` | List workspace users (mock data) |
| `POST` | `/api/users` | Add a user |
| `DELETE` | `/api/users/:id` | Remove a user |
| `POST` | `/api/test-connectivity` | Simulate vector DB connectivity test |

#### SSE Event Format (`/api/sources`, `/api/sources/:id/reindex`)

The document indexing endpoints use **Server-Sent Events**. Connect with `fetch` and read the stream:

```
event: start
data: {"doc": {...}, "total": 42}

event: progress
data: {"done": 7, "total": 42}

event: done
data: {"doc": {...}}

event: error
data: {"message": "Ollama embed failed on chunk 3: ..."}
```

### 8.2 Agent API (External Integration)

#### Management endpoints (no auth — called by the dashboard)

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/agent/keys` | List all API keys (secrets always masked) |
| `POST` | `/api/agent/keys` | Create a new API key — **returns the full secret once only** |
| `PATCH` | `/api/agent/keys/:id` | Update label, rateLimit, pipelineId, sourceFilter, enabled |
| `DELETE` | `/api/agent/keys/:id` | Permanently revoke an API key |

#### Agent endpoints (require `X-API-Key` header)

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/agent/query` | Full RAG — embed → retrieve → generate |
| `POST` | `/api/agent/retrieve` | Vector search only, no LLM generation |
| `GET` | `/api/agent/sources` | List Synced sources accessible to this key |

---

## 9. Agent API — Integration Guide

This section is the primary reference for teams integrating external AI agents, bots, or automation pipelines with Marmot RAG.

### 9.1 Authentication

All agent endpoints require the API key to be passed in the `X-API-Key` HTTP request header.

```
X-API-Key: mrmk_<64-char-hex-secret>
```

Keys are issued from the **Agent API Access** tab in the dashboard. The full key is shown **once** upon creation. Store it in your secret manager immediately.

**Key capabilities (configured per key):**
- `pipelineId` — binds the key to a specific pipeline (agent may still override via request body)
- `sourceFilter` — restricts retrieval to a subset of knowledge-base sources (`[]` = all Synced)
- `rateLimit` — maximum requests per minute (sliding 60-second window); `0` = unlimited

---

### 9.2 `POST /api/agent/query`

Full RAG pipeline — embeds the query, retrieves top-K context chunks from pgvector, and generates a grounded answer via the pipeline's configured LLM (Gemini or Ollama). The query is automatically written to the system query log with an `[agent:<key-label>]` tag.

**Request**

```http
POST /api/agent/query HTTP/1.1
Content-Type: application/json
X-API-Key: mrmk_<your_key>
```

```json
{
  "query": "What are the Q3 revenue figures?",
  "pipeline": "Doc-Search-Alpha",
  "topK": 5,
  "minScore": 0.3,
  "sourceFilter": ["src-1", "src-2"]
}
```

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `query` | `string` | ✅ | — | Natural language question |
| `pipeline` | `string` | ❌ | Key's bound pipeline, or first enabled | Pipeline name to use |
| `topK` | `number` | ❌ | Pipeline's `topK` | Number of chunks to retrieve (1–10) |
| `minScore` | `number` | ❌ | Pipeline's `minScore` | Minimum cosine similarity threshold (0–1) |
| `sourceFilter` | `string[]` | ❌ | Key's `sourceFilter` | Restrict retrieval to these source IDs |

**Response 200**

```json
{
  "answer": "Q3 revenues increased by 15.4% quarter-over-quarter, reaching $42.6M. [Q3 Financial Reports]",
  "pipeline": "Doc-Search-Alpha",
  "faithfulnessScore": 97,
  "relevanceScore": 93,
  "latencyMs": 840,
  "sources": [
    {
      "id": "src-1-chk-0",
      "sourceName": "Q3 Financial Reports",
      "score": 0.9241,
      "excerpt": "Revenues increased by 15.4% quarter-over-quarter, reaching a historic high of $42.6 million..."
    }
  ]
}
```

| Field | Type | Description |
|---|---|---|
| `answer` | `string` | LLM-generated grounded answer citing source names |
| `pipeline` | `string` | Name of the pipeline that served the query |
| `faithfulnessScore` | `number` | 0–100: how well the answer is supported by retrieved chunks |
| `relevanceScore` | `number` | 0–100: how relevant the retrieved chunks were to the query |
| `latencyMs` | `number` | End-to-end latency including embedding + retrieval + generation |
| `sources` | `array` | Top-K chunks used as context, with similarity score and 200-char excerpt |

---

### 9.3 `POST /api/agent/retrieve`

Pure vector similarity search — no LLM generation. Returns the top-K matching text chunks with cosine similarity scores. Use this endpoint when your agent uses its own LLM, does prompt assembly externally, or needs raw context for a multi-step reasoning chain.

**Request**

```http
POST /api/agent/retrieve HTTP/1.1
Content-Type: application/json
X-API-Key: mrmk_<your_key>
```

```json
{
  "query": "compliance rules tier 3 data centers",
  "topK": 5,
  "minScore": 0.0,
  "sourceFilter": []
}
```

**Response 200**

```json
{
  "query": "compliance rules tier 3 data centers",
  "latencyMs": 42,
  "chunks": [
    {
      "id": "src-1-chk-0",
      "sourceId": "src-1",
      "sourceName": "Q3 Financial Reports",
      "text": "Standard compliance was fully met across tier 3 data center regions for regulatory operations.",
      "score": 0.9241
    },
    {
      "id": "src-2-chk-1",
      "sourceId": "src-2",
      "sourceName": "Customer Support Docs",
      "text": "Latency fallback mode switches automatically to the Azure AI Search vector database...",
      "score": 0.7812
    }
  ]
}
```

---

### 9.4 `GET /api/agent/sources`

Lists all Synced knowledge-base source documents accessible to the API key. Respects the key's `sourceFilter` configuration — if the key was issued with a restricted source scope, only those sources are returned.

**Request**

```http
GET /api/agent/sources HTTP/1.1
X-API-Key: mrmk_<your_key>
```

**Response 200**

```json
{
  "sources": [
    {
      "id": "src-1",
      "name": "Q3 Financial Reports",
      "type": "PDF Collection",
      "vectorsCount": 24510,
      "lastSync": "2 hours ago"
    },
    {
      "id": "src-2",
      "name": "Customer Support Docs",
      "type": "Notion Webhook",
      "vectorsCount": 102933,
      "lastSync": "In progress"
    }
  ]
}
```

---

### 9.5 Error Reference

All agent endpoints return structured JSON errors.

| HTTP Status | `error` message | Cause |
|---|---|---|
| `400` | `"query (string) is required"` | Missing or non-string `query` field in request body |
| `400` | `"label is required"` | Missing label when creating a key |
| `401` | `"Missing X-API-Key header."` | No `X-API-Key` header sent |
| `401` | `"Invalid API key."` | Key does not exist |
| `403` | `"This API key has been disabled."` | Key is disabled from the dashboard |
| `404` | `"Key not found"` | PATCH/DELETE targeting a non-existent key ID |
| `429` | `"Rate limit exceeded. Max N req/min."` | Key's sliding-window rate limit exceeded |
| `500` | `"Embedding failed. Is Ollama running with qwen3-embedding:4b?"` | Ollama is not running or model not pulled |

---

### 9.6 Python Example (LangChain-style)

```python
import requests

MARMOT_BASE = "http://your-host:3000"
API_KEY = "mrmk_<your_key>"

headers = {
    "Content-Type": "application/json",
    "X-API-Key": API_KEY,
}

# ── Full RAG query ────────────────────────────────────────────────────────────
resp = requests.post(
    f"{MARMOT_BASE}/api/agent/query",
    headers=headers,
    json={
        "query": "What are the compliance rules for Tier 3 data centers?",
        "pipeline": "Legal-Brief-Retriever",
        "topK": 5,
    },
)
resp.raise_for_status()
data = resp.json()
print("Answer:", data["answer"])
print(f"Faithfulness: {data['faithfulnessScore']}%  |  Latency: {data['latencyMs']}ms")

# ── Pure vector retrieval (bring your own LLM) ────────────────────────────────
resp = requests.post(
    f"{MARMOT_BASE}/api/agent/retrieve",
    headers=headers,
    json={"query": "secondary work IP policy", "topK": 3},
)
chunks = resp.json()["chunks"]
context = "\n\n".join(c["text"] for c in chunks)
print("Context assembled for your LLM:", context[:500])

# ── Discover available sources ────────────────────────────────────────────────
sources = requests.get(f"{MARMOT_BASE}/api/agent/sources", headers=headers).json()
for s in sources["sources"]:
    print(f"  [{s['id']}] {s['name']} — {s['vectorsCount']:,} vectors")
```

---

### 9.7 curl Examples

```bash
# Full RAG query
curl -s -X POST http://localhost:3000/api/agent/query \
  -H "Content-Type: application/json" \
  -H "X-API-Key: mrmk_<your_key>" \
  -d '{"query": "What is the latency fallback policy?"}' | jq .answer

# Pure vector retrieval
curl -s -X POST http://localhost:3000/api/agent/retrieve \
  -H "Content-Type: application/json" \
  -H "X-API-Key: mrmk_<your_key>" \
  -d '{"query": "tier 3 compliance", "topK": 3}' | jq '.chunks[] | .sourceName, .score'

# List accessible sources
curl -s http://localhost:3000/api/agent/sources \
  -H "X-API-Key: mrmk_<your_key>" | jq '.sources[] | .name'
```

---

## 10. RAG Pipeline System

A **Pipeline** is a named, reusable configuration that controls every aspect of a RAG query:

| Field | Type | Description |
|---|---|---|
| `name` | `string` | Unique identifier used in API calls (`pipeline: "Doc-Search-Alpha"`) |
| `description` | `string` | Human-readable purpose |
| `generationModel` | `string` | `"gemini-3.5-flash"` \| `"gemini-1.5-pro"` \| `"ollama:<model>"` \| `"offline"` |
| `topK` | `number` | Number of chunks to retrieve (1–10) |
| `minScore` | `number` | Minimum cosine similarity to include a chunk (0–1) |
| `systemPrompt` | `string` | Custom LLM system instruction (blank = default analytical RAG prompt) |
| `sourceFilter` | `string[]` | Restrict retrieval to these source IDs (`[]` = all Synced sources) |
| `enabled` | `boolean` | Disabled pipelines are hidden from Playground and fallback-skipped by Agent API |

Three seed pipelines are included:
- **Doc-Search-Alpha** — general-purpose, broad coverage, Ollama local LLM
- **Legal-Brief-Retriever** — high-precision, legal tone system prompt, Gemini, minScore 0.6
- **Customer-Support-LLM** — customer-facing, friendly prompt, Gemini (disabled by default)

Pipeline statistics (avg latency, faithfulness, relevance, last used) are computed live from the in-memory query log on every `/api/pipelines` request.

---

## 11. Chunking & Embedding

### Strategies

| Strategy | Algorithm | Best for |
|---|---|---|
| **Semantic** | Sentence-boundary sliding window with overlap (CJK + Latin punctuation) | Narrative text, documents with clear sentence structure |
| **Fixed** | jieba token sliding window with configurable stride | Tables, lists, structured data |
| **Recursive** | Split on blank lines → fallback to Fixed for long paragraphs | Mixed-format documents |

### CJK Support

Tokenization uses `jieba-wasm` (Rust/WASM, no native build). Each CJK word is counted as one token, giving accurate chunk sizing for Chinese, Japanese, and mixed-language documents.

### Embedding Model

- **Model**: `qwen3-embedding:4b` (Ollama, local inference)
- **Raw dimensions**: 2560
- **Stored dimensions**: 2000 (Matryoshka truncation — first 2000 dims preserve ~99% of semantic information; required by pgvector `ivfflat` limit)
- **Context window**: 32,768 tokens
- **Languages**: Native Chinese (Simplified + Traditional), English, 100+ languages

The embedding function sanitizes text before sending to Ollama: collapses repeated punctuation, normalizes whitespace, and hard-caps at 2000 characters to prevent CJK tokenizer explosion.

---

## 12. User & Access Management

### Current State (Mock Data)

User management in the Admin tab uses **in-memory mock data**. Three demo users are seeded at startup. Add and delete operations work against this in-memory store and reset on server restart.

### SSO Integration (Reserved Interface)

The `ssoEnabled` toggle in the Admin tab and the `StrategyConfig.ssoEnabled` field in the type system are **reserved for enterprise SSO integration** (Microsoft Entra ID / Okta). The interface is complete; backend enforcement is intentionally left as a no-op until the SSO provider is configured in your environment.

To integrate SSO:
1. Add your IdP credentials to `.env` (`SSO_TENANT_ID`, `SSO_CLIENT_ID`, `SSO_CLIENT_SECRET`, etc.)
2. Implement a `validateSSOToken(token: string): Promise<User>` function in a new `src/sso.ts`
3. Wire it into a new `ssoAuth` Express middleware, replacing the current no-op in user-facing routes
4. The `POST /api/users` endpoint is already structured to accept role assignment on creation

### Role System

| Role | Description |
|---|---|
| `Super Admin` | Full access — all tabs, all configuration, user management |
| `Developer` | Knowledge base, pipelines, playground, API key management |
| `Editor` | Knowledge base only — add/delete documents |
| `Compliance` | Read-only access to query logs and dashboard |
| `Viewer` | Playground queries only |

Role enforcement is a future implementation — roles are stored but not yet enforced by middleware.

---

## 13. Build for Production

```bash
# Build frontend (Vite) + backend (esbuild)
npm run build

# Start compiled production server
npm run start
```

The build script:
1. Runs `vite build` → outputs static assets to `dist/`
2. Runs `esbuild server.ts` → outputs `dist/server.cjs`

The production server serves static files from `dist/` and falls back to `index.html` for SPA routing.

**Important**: Set `NODE_ENV=production` in your production environment to disable Vite dev middleware.

---

## 14. Developer Guide

### Adding a New Tab

1. Add the tab ID to `TabType` in `src/types.ts`
2. Add a sidebar `<button>` in the nav section of `App.tsx`
3. Add a mobile nav button in the bottom nav bar
4. Add a `{activeTab === "your-tab" && (...)}` block in the content area

### Adding a New API Route

1. Define the route in `server.ts` following the existing pattern
2. For agent-authenticated routes, pass `agentAuth` as the second argument:
   ```typescript
   app.post("/api/agent/your-route", agentAuth, async (req, res) => {
     const agentKey = (req as any)._agentKey as AgentApiKey;
     // ...
   });
   ```
3. Add corresponding fetch calls in `App.tsx` handlers

### Type Safety

All shared interfaces live in `src/types.ts`. Both `server.ts` and `App.tsx` import from there. When adding fields:
- Update `src/types.ts` first
- Align the server-side interface (duplicated in `server.ts` for ESM compatibility)
- Update relevant API response shapes

### Coding Rules

**Lazy AI initialization** — always use `getAI()`:
```typescript
const ai = getAI();
if (ai) {
  // safe to call Gemini
}
```

**Port** — do not change. Port `3000` on `0.0.0.0` is the single entry point:
```typescript
app.listen(PORT, "0.0.0.0", () => { ... });
```

**Styling** — use Tailwind utility classes directly in JSX. For shared card styles, use the `.soft-card` utility. Add light-theme overrides in the `.theme-light` block in `src/index.css`.

**Agent keys** — the full API key secret is returned **once only** on `POST /api/agent/keys`. The `key` field is never included in list responses (`GET /api/agent/keys`). This is enforced by the `key: undefined` omission in the list handler.
