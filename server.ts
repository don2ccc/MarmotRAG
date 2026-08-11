import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import path from "path";
import dotenv from "dotenv";
import { createServer as createViteServer } from "vite";
import {
  initDb, upsertChunk, upsertSource, loadSources, countSources, countChunks,
  loadConfig, saveConfig,
  loadAgentKeys, upsertAgentKey, countAgentKeys,
  loadQueryLogs, insertQueryLog, queryLogsPaginated,
  loadUsers, upsertUser, countUsers, closePool,
} from "./src/db.js";
import { embedText } from "./src/embeddings.js";
import { chunkText } from "./src/retrieval.js";
import { createResolveUser } from "./src/auth.js";
import { store } from "./src/store.js";
import { createSourcesRouter } from "./src/routes/sources.js";
import { createAgentRouter } from "./src/routes/agent.js";
import { createSystemRouter } from "./src/routes/system.js";
import type { AgentApiKey, QueryLog, SourceDoc } from "./src/types.js";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 3000;

// ── Security & CORS middleware ──────────────────────────────────────────
const rawOrigins = process.env.CORS_ORIGINS || "*";
const corsOrigins = rawOrigins === "*" ? "*" : rawOrigins.split(",").map(o => o.trim());
app.use(cors({
  origin: corsOrigins,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-API-Key", "X-User-Id"],
}));

// Disable helmet's contentSecurityPolicy in dev (Vite uses inline scripts)
app.use(helmet({
  contentSecurityPolicy: process.env.NODE_ENV === "production",
  crossOriginEmbedderPolicy: false,
}));

// 50MB limit for PDF uploads; all other JSON limited to 2MB
app.use("/api/parse-pdf", express.json({ limit: "50mb" }));
app.use(express.json({ limit: "2mb" }));

// HTTP request logging — concise in dev, combined in production
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));

// ── Demo identity: resolve X-User-Id → req.user (swap for session/JWT later) ──
app.use(createResolveUser(() => store.users));

// ── Seed documents — written to DB only when marmot_sources is empty ─────
const SEED_SOURCES: Omit<SourceDoc, "chunks">[] = [
  {
    id: "src-1",
    name: "Q3 Financial Reports",
    type: "PDF Collection",
    status: "Synced",
    lastSync: "2 hours ago",
    vectorsCount: 0,
    ownerId: "u-1",
    ownerName: "Jane Doe",
    isShared: false,
    content: "RAG Enterprise Financial Report for Q3 2026. Revenues increased by 15.4% quarter-over-quarter, reaching a historic high of $42.6 million. Operation costs were kept under control, decreasing overall system latency and optimizing API credit costs. Standard compliance was fully met across tier 3 data center regions.",
  },
  {
    id: "src-2",
    name: "Customer Support Docs",
    type: "Notion Webhook",
    status: "Synced",
    lastSync: "In progress",
    vectorsCount: 0,
    ownerId: "u-1",
    ownerName: "Jane Doe",
    isShared: true,
    content: "Customer support rules require a Microsoft Entra or Okta Single Sign-On (SSO) for authentication. Secondary work policy states that employees must request written super-admin permission before taking on external development work to ensure there is no IP collision. Latency fallback mode switches automatically to the Azure AI Search vector database if primary Pinecone API response latency exceeds 500ms.",
  },
  {
    id: "src-4",
    name: "Enterprise Network Topology",
    type: "HTML Document",
    status: "Synced",
    lastSync: "10 mins ago",
    vectorsCount: 0,
    ownerId: "u-1",
    ownerName: "Jane Doe",
    isShared: true,
    content: `<h3>Enterprise Multi-Region Network Architecture</h3>
<p>Our primary database cluster is distributed across multiple regions to ensure high availability. The connection topology and physical server layout is detailed in the diagram below:</p>
<div class="image-container">
  <img src="https://images.unsplash.com/photo-1558494949-ef010cbdcc31?auto=format&fit=crop&w=800&q=80" alt="Enterprise Network Topology Diagram" />
</div>
<p>Data is continuously synchronized between the primary Pinecone vector database and the secondary Weaviate instance. The logical pipeline routing is illustrated here:</p>
<div class="image-container">
  <img src="https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?auto=format&fit=crop&w=800&q=80" alt="Data Pipeline Routing Blueprint" />
</div>
<p>Additionally, we maintain a dedicated security guard layer to audit all LLM query-response pairs for compliance. The security zone layout is shown in this concept map:</p>
<div class="image-container">
  <img src="https://images.unsplash.com/photo-1544383835-bda2bc66a55d?auto=format&fit=crop&w=800&q=80" alt="Security Guard Audit Layout Map" />
</div>`,
  },
  {
    id: "src-3",
    name: "Legacy Product Manuals",
    type: "G-Drive Archive",
    status: "Synced",
    lastSync: "3 days ago",
    vectorsCount: 0,
    ownerId: "u-2",
    ownerName: "Marcus Kane",
    isShared: false,
    content: "The original System-900 series utilizes fixed-size chunks of 256 tokens and 10% overlap. This legacy setting is now retired but documentation is kept for regulatory compliance. System-900 compliance rules dictate strict air-gapped deployments for public sector clients.",
  },
];

// ── Seed users ───────────────────────────────────────────────────────────
const SEED_USERS = [
  { id: "u-1", name: "Jane Doe",     email: "jane.doe@enterprise.ai",  role: "Super Admin", lastLogin: "2 mins ago" },
  { id: "u-2", name: "Marcus Kane",  email: "m.kane@enterprise.ai",     role: "Developer",   lastLogin: "3 hours ago" },
  { id: "u-3", name: "Sarah Lim",    email: "slim@enterprise.ai",        role: "Viewer",      lastLogin: "Yesterday" },
];

// ── Seed query logs (retrieval only) ────────────────────────────────────
const SEED_QUERY_LOGS: QueryLog[] = [
  {
    id: "log-1",
    timestamp: new Date(Date.now() - 1000 * 60 * 5).toISOString(),
    query: "What are the compliance rules for Tier 3 data centers?",
    userId: "u-1",
    via: "user",
    latencyMs: 182,
    status: "success",
    retrievedChunks: [
      { chunkId: "src-2-chk-0", sourceName: "Customer Support Docs", text: "Standard compliance was fully met across tier 3 data center regions.", score: 0.95 }
    ]
  },
  {
    id: "log-2",
    timestamp: new Date(Date.now() - 1000 * 60 * 7).toISOString(),
    query: "Retrieve corporate regulations on secondary development work.",
    userId: "u-1",
    via: "user",
    latencyMs: 315,
    status: "success",
    retrievedChunks: [
      { chunkId: "src-2-chk-1", sourceName: "Customer Support Docs", text: "Secondary work policy states that employees must request written super-admin permission before taking on external development work to ensure there is no IP collision.", score: 0.88 }
    ]
  },
  {
    id: "log-3",
    timestamp: new Date(Date.now() - 1000 * 60 * 9).toISOString(),
    query: "Show me the distribution of our database cluster diagram.",
    userId: "u-1",
    via: "user",
    latencyMs: 245,
    status: "success",
    retrievedChunks: [
      { chunkId: "src-4-chk-0", sourceName: "Enterprise Network Topology", text: "Our primary database cluster is distributed across multiple regions.", score: 0.92 }
    ]
  }
];

// ── Seed agent key (demo) ────────────────────────────────────────────────
const SEED_AGENT_KEYS: AgentApiKey[] = [
  {
    id: "akey-1",
    label: "Demo LangChain Agent",
    key: "mrmk_demo_0000000000000000000000000000000000000000000000000000000000000000",
    keyPreview: "mrmk_demo_****...****0000",
    ownerId: "u-1",
    sourceFilter: [],
    rateLimit: 60,
    enabled: true,
    createdAt: new Date(Date.now() - 86400000 * 5).toISOString(),
    lastUsedAt: new Date(Date.now() - 3600000).toISOString(),
    usageCount: 0,
    usageThisMonth: 0,
    _monthStamp: new Date().toISOString().slice(0, 7),
  },
];

// ── Default strategy config (chunking only) ──────────────────────────────
const DEFAULT_STRATEGY_CONFIG = {
  chunkSize: 200,
  chunkOverlap: 20,
  separationStrategy: "Semantic",
  pgHost: process.env.PG_HOST || "127.0.0.1",
  pgPort: process.env.PG_PORT || "5432",
  pgDatabase: process.env.PG_DATABASE || "ai_hub",
  pgTable: "marmot_chunks",
  embeddingProvider: "Ollama (Local)",
  embeddingModel: "qwen3-embedding:4b",
  embeddingDimension: 2000,
  ollamaBaseUrl: process.env.OLLAMA_BASE_URL || "http://localhost:11434",
};

/**
 * Load all business state from DB into memory, seeding on first run.
 * Called once after initDb() at startup.
 */
async function initializeState(): Promise<void> {
  // Users first (ownerName resolution depends on them)
  const userCount = await countUsers();
  if (userCount === 0) {
    for (const u of SEED_USERS) await upsertUser(u);
    console.log("[users] Seeded default users to DB");
  }
  store.users = await loadUsers();
  console.log(`[users] Loaded ${store.users.length} user(s) from DB`);

  // Sources
  const existing = await countSources();
  if (existing === 0) {
    console.log("[sources] Empty DB — seeding initial documents...");
    for (const doc of SEED_SOURCES) {
      const owner = store.users.find(u => u.id === doc.ownerId);
      const ownerName = owner?.name ?? doc.ownerName;
      await upsertSource({
        id: doc.id, name: doc.name, type: doc.type, status: doc.status, lastSync: doc.lastSync,
        vectorsCount: doc.vectorsCount, owner: ownerName, ownerAvatar: "",
        ownerId: doc.ownerId, isShared: doc.isShared, content: doc.content,
      });
      // Embed seed chunks
      const rawChunks = chunkText(doc.content, 120, 15, "Semantic");
      for (let idx = 0; idx < rawChunks.length; idx++) {
        try {
          const embedding = await embedText(rawChunks[idx]);
          await upsertChunk({
            id: `${doc.id}-chk-${idx}`, sourceId: doc.id, sourceName: doc.name,
            text: rawChunks[idx], tokensCount: rawChunks[idx].split(/\s+/).length, embedding,
          });
        } catch (err) {
          console.warn(`[seed] embed failed for ${doc.id}-chk-${idx}:`, err);
        }
      }
      console.log(`[seed] Embedded: ${doc.name}`);
    }
  }
  const rows = await loadSources();
  store.sources = rows.map(r => {
    const owner = store.users.find(u => u.id === r.ownerId);
    return {
      ...r,
      status: r.status as SourceDoc["status"],
      ownerName: owner?.name ?? r.owner,
      chunks: [],
    };
  });
  console.log(`[sources] Loaded ${store.sources.length} source(s) from DB`);

  // If marmot_chunks is empty but we have synced sources, mark them for reindex.
  const chunkTotal = await countChunks();
  if (chunkTotal === 0 && store.sources.length > 0) {
    console.warn("[sources] marmot_chunks is empty — marking all sources as needing reindex");
    for (const doc of store.sources) {
      if (doc.status === "Synced") {
        doc.status = "Paused";
        await upsertSource({
          id: doc.id, name: doc.name, type: doc.type, status: "Paused", lastSync: doc.lastSync,
          vectorsCount: 0, owner: doc.ownerName, ownerAvatar: "", ownerId: doc.ownerId,
          isShared: doc.isShared, content: doc.content,
        });
      }
    }
  }

  // Strategy config
  const savedCfg = await loadConfig();
  if (savedCfg) {
    store.strategyConfig = { ...DEFAULT_STRATEGY_CONFIG, ...savedCfg } as typeof DEFAULT_STRATEGY_CONFIG;
    console.log("[config] Loaded strategy config from DB");
  } else {
    store.strategyConfig = { ...DEFAULT_STRATEGY_CONFIG };
    await saveConfig(store.strategyConfig as unknown as Record<string, unknown>);
    console.log("[config] Seeded default strategy config to DB");
  }

  // Agent keys
  const keyCount = await countAgentKeys();
  if (keyCount === 0) {
    for (const k of SEED_AGENT_KEYS) {
      await upsertAgentKey({ ...k, monthStamp: k._monthStamp });
    }
    console.log("[agent-keys] Seeded demo key to DB");
  }
  const dbKeys = await loadAgentKeys();
  store.agentKeys = dbKeys.map(k => ({ ...k, _monthStamp: k.monthStamp }));
  console.log(`[agent-keys] Loaded ${store.agentKeys.length} key(s) from DB`);

  // Query logs
  const { logs: existingLogs } = await queryLogsPaginated({ limit: 1, offset: 0 });
  if (existingLogs.length === 0) {
    for (const l of SEED_QUERY_LOGS) await insertQueryLog(l);
    console.log("[query-logs] Seeded demo log(s) to DB");
  }
  store.queryLogs = (await loadQueryLogs(200)).map(l => ({
    ...l,
    status: l.status as QueryLog["status"],
  }));
  console.log(`[query-logs] Loaded ${store.queryLogs.length} recent log(s) from DB`);
}

// ── Compact OpenAPI for the retrieval-only surface ───────────────────────
const OPENAPI = {
  openapi: "3.0.3",
  info: {
    title: "Marmot RAG Retrieval API",
    version: "1.0.0",
    description: "Multi-user, shareable knowledge retrieval. Authenticate agent calls with X-API-Key; dashboard calls use X-User-Id (demo mode).",
  },
  paths: {
    "/api/health": { get: { summary: "System health", responses: { "200": { description: "OK" } } } },
    "/api/sources": {
      get: { summary: "List visible sources", responses: { "200": { description: "Sources visible to current user" } } },
      post: { summary: "Add a document (SSE progress)", responses: { "200": { description: "SSE stream" } } },
    },
    "/api/retrieve": {
      post: {
        summary: "Retrieve chunks (dashboard, X-User-Id)",
        requestBody: { content: { "application/json": { schema: { type: "object", properties: { query: { type: "string" }, topK: { type: "number" }, minScore: { type: "number" }, sourceFilter: { type: "array", items: { type: "string" } } } } } } },
        responses: { "200": { description: "Chunks with scores" } },
      },
    },
    "/api/agent/sources": {
      get: { summary: "List sources the API key may query", security: [{ ApiKeyAuth: [] }], responses: { "200": { description: "Visible sources" } } },
    },
    "/api/agent/retrieve": {
      post: {
        summary: "Retrieve chunks (X-API-Key)",
        security: [{ ApiKeyAuth: [] }],
        requestBody: { content: { "application/json": { schema: { type: "object", properties: { query: { type: "string" }, topK: { type: "number" }, minScore: { type: "number" }, sourceFilter: { type: "array", items: { type: "string" } } } } } } },
        responses: { "200": { description: "Chunks with scores" } },
      },
    },
    "/api/agent/keys": {
      get: { summary: "List own API keys", responses: { "200": { description: "Keys" } } },
      post: { summary: "Create API key", responses: { "201": { description: "Created (full key returned once)" } } },
    },
  },
  components: {
    securitySchemes: {
      ApiKeyAuth: { type: "apiKey", in: "header", name: "X-API-Key" },
    },
  },
};

// ── Routes ───────────────────────────────────────────────────────────────
app.use("/api", createSourcesRouter());
app.use("/api", createAgentRouter());
app.use("/api", createSystemRouter());

app.get("/api/openapi.json", (_req, res) => res.json(OPENAPI));
app.get("/.well-known/openapi.json", (_req, res) => res.json(OPENAPI));
app.get("/api/docs", (_req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.send(`<!doctype html><html><head><meta charset="utf-8"><title>Marmot RAG API</title></head>
<body style="font-family:system-ui;max-width:720px;margin:40px auto">
<h1>Marmot RAG — Retrieval API</h1>
<p>OpenAPI: <a href="/api/openapi.json">/api/openapi.json</a></p>
<h2>Agent endpoints (X-API-Key)</h2>
<ul>
<li><code>POST /api/agent/retrieve</code> — query → chunks (chunkId, sourceName, text, score, tokenCount) + context</li>
<li><code>GET /api/agent/sources</code> — sources the key may query</li>
</ul>
<h2>Key management (dashboard)</h2>
<ul>
<li><code>GET|POST /api/agent/keys</code> — list / create own keys</li>
<li><code>PATCH|DELETE /api/agent/keys/:id</code> — update / revoke</li>
</ul>
</body></html>`);
});

// ── Vite setup or production static server ──────────────────────────────
async function startServer() {
  // Init tables, then load/seed all state from DB
  await initDb();
  await initializeState();

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "custom",
    });
    app.use(vite.middlewares);
    // SPA fallback: serve index.html ONLY for browser navigation (non-API, non-asset requests)
    app.use(async (req, res, next) => {
      if (
        req.path.startsWith("/api") ||
        req.path.startsWith("/.well-known") ||
        req.path.includes(".")
      ) {
        return next();
      }
      try {
        const { readFileSync } = await import("fs");
        const { resolve } = await import("path");
        let html = readFileSync(resolve(process.cwd(), "index.html"), "utf-8");
        html = await vite.transformIndexHtml(req.originalUrl, html);
        res.status(200).setHeader("Content-Type", "text/html").end(html);
      } catch (e) {
        next(e);
      }
    });
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  // Global error handler — catches unhandled errors thrown by route handlers
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error("[error]", err.stack ?? err.message);
    res.status(500).json({ error: "Internal server error." });
  });

  const httpServer = app.listen(PORT, "0.0.0.0", () => {
    console.log(`[server] Listening on port ${PORT}`);
  });

  // API versioning stub — /api/v1/* mirrors /api/*
  app.all("/api/v1/*", (req, res) => {
    req.url = req.url.replace(/^\/api\/v1/, "/api");
    app._router.handle(req, res, () => {
      if (!res.headersSent) res.status(404).json({ error: "Not found" });
    });
  });

  // Graceful shutdown
  const shutdown = (signal: string) => {
    console.log(`[server] ${signal} received — shutting down gracefully`);
    httpServer.close(async () => {
      console.log("[server] HTTP server closed.");
      try {
        await closePool();
        console.log("[db] Connection pool closed.");
      } catch { /* pool may already be closed */ }
      process.exit(0);
    });
    setTimeout(() => {
      console.error("[server] Forced shutdown after 30s timeout.");
      process.exit(1);
    }, 30_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

startServer().catch(err => {
  console.error("[server] Failed to start:", err);
  process.exit(1);
});
