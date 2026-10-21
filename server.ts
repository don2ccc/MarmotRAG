import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import path from "path";
import dotenv from "dotenv";
import { createServer as createViteServer } from "vite";
import {
  initDb, upsertSource, loadSources, countSources,
  loadConfig, saveConfig,
  loadVersionStates, recoverInterruptedVersions, listRebuildCandidates,
  loadAgentKeys, upsertAgentKey, countAgentKeys,
  loadQueryLogs, insertQueryLog, queryLogsPaginated,
  loadUsers, upsertUser, countUsers, closePool,
  ensureSessionSecret, findAdminUser, setUserPassword, updateUserEmail,
} from "./src/db.js";
import { indexSource, policyFromConfig, rebuildMissingVersions } from "./src/indexing.js";
import { createRequireAdmin } from "./src/auth.js";
import { configureSessionSecret } from "./src/session.js";
import { hashPassword } from "./src/password.js";
import { createAuthRouter } from "./src/routes/auth.js";
import { randomBytes } from "node:crypto";
import { store } from "./src/store.js";
import { createSourcesRouter } from "./src/routes/sources.js";
import { createAgentRouter, maskKey } from "./src/routes/agent.js";
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

// Large JSON bodies for document parsing and indexing — the product allows
// 50 MB files, and base64 inflates to ~4/3, so leave headroom. All other JSON
// stays at 2MB.
app.use("/api/parse-document", express.json({ limit: "100mb" }));
app.use("/api/sources", express.json({ limit: "100mb" }));
app.use(express.json({ limit: "2mb" }));

// HTTP request logging — concise in dev, combined in production
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));

// ── Admin-only console API (agent endpoints use X-API-Key instead) ──────
const requireAdmin = createRequireAdmin();
app.use("/api/auth", createAuthRouter());
app.use("/api", (req, res, next) => {
  // Health and API docs stay public; everything else is admin or agent-key.
  if (req.path === "/health" || req.path === "/docs" || req.path === "/openapi.json") {
    next();
    return;
  }
  requireAdmin(req, res, next);
});

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
    scope: {
      all: true,
      collections: [],
      kinds: [],
      tags: [],
      docIds: [],
      allowDraft: false,
      allowExpired: false,
      allowAsOf: true,
    },
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
  // Percentage of chunkSize (matches the dashboard label). Older installs
  // stored a token count here; initializeState() converts those once.
  chunkOverlap: 10,
  chunkOverlapUnit: "percent" as const,
  // Clause-aware by default: 制度/合同 are indexed one clause per chunk with
  // clause_no/clause_path, which is what citations need. Documents without
  // clause markers fall back to sentence packing automatically.
  separationStrategy: "Clause",
  pgHost: process.env.PG_HOST || "127.0.0.1",
  pgPort: process.env.PG_PORT || "5432",
  pgDatabase: process.env.PG_DATABASE || "ai_hub",
  pgTable: "marmot_chunks",
  embeddingProvider: "Ollama (Local)",
  embeddingModel: process.env.OLLAMA_EMBED_MODEL || "qwen3-embedding:4b",
  embeddingDimension: 2000,
  ollamaBaseUrl: process.env.EMBED_BASE_URL || process.env.OLLAMA_BASE_URL || "http://localhost:11434",
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

  // ── Authentication bootstrap ─────────────────────────────────────────
  configureSessionSecret(await ensureSessionSecret());
  const admin = await findAdminUser();
  if (!admin) {
    console.warn("[auth] No admin user exists — signing in is impossible until one is created.");
  } else {
    if (process.env.ADMIN_EMAIL && process.env.ADMIN_EMAIL.trim().toLowerCase() !== admin.email.toLowerCase()) {
      await updateUserEmail(admin.id, process.env.ADMIN_EMAIL.trim().toLowerCase());
      admin.email = process.env.ADMIN_EMAIL.trim().toLowerCase();
      console.log(`[auth] Admin email set to ${admin.email}`);
    }
    if (!admin.passwordHash) {
      const fromEnv = process.env.ADMIN_PASSWORD?.trim();
      const password = fromEnv || randomBytes(9).toString("base64url");
      await setUserPassword(admin.id, hashPassword(password));
      if (fromEnv) {
        console.log(`[auth] Admin password initialised for ${admin.email}`);
      } else {
        console.warn(
          `[auth] Generated admin password for ${admin.email}: ${password}\n` +
          `[auth] Set ADMIN_PASSWORD (and ADMIN_EMAIL) to choose your own, then change it in the UI.`
        );
      }
    }
    console.log(`[auth] Sign in with ${admin.email}`);
  }

  // Sources
  const existing = await countSources();
  if (existing === 0) {
    console.log("[sources] Empty DB — seeding initial documents...");
    const policy = policyFromConfig(DEFAULT_STRATEGY_CONFIG);
    for (const doc of SEED_SOURCES) {
      const owner = store.users.find(u => u.id === doc.ownerId);
      const ownerName = owner?.name ?? doc.ownerName;
      await upsertSource({
        id: doc.id, name: doc.name, type: doc.type, status: "Syncing...", lastSync: "",
        vectorsCount: 0, owner: ownerName, ownerAvatar: "",
        ownerId: doc.ownerId, isShared: doc.isShared, content: doc.content,
      });
      try {
        const result = await indexSource({
          sourceId: doc.id,
          sourceName: doc.name,
          content: doc.content,
          chunkSize: policy.chunkSize,
          chunkOverlapPercent: policy.chunkOverlapPercent,
          strategy: policy.strategy,
        });
        console.log(`[seed] Embedded: ${doc.name} (${result.chunkCount} chunks)`);
      } catch (err) {
        console.warn(`[seed] embed failed for ${doc.id}:`, err);
      }
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

  // ── Repair version state left behind by a crash ───────────────────────
  // A version that was `building` at boot can never be resumed: its chunks are
  // incomplete. Drop those chunks, mark the version failed, and clear pointers
  // to versions that are no longer active. Documents without a servable version
  // are queued for rebuild from their retained content — the previous behaviour
  // deleted every chunk and marked the document Paused, silently losing knowledge.
  const recovery = await recoverInterruptedVersions();
  if (recovery.interrupted > 0) {
    console.warn(`[sources] recovered ${recovery.interrupted} interrupted version build(s) — partial chunks dropped`);
  }
  if (recovery.cleared > 0) {
    console.warn(`[sources] cleared ${recovery.cleared} document(s) pointing at a non-active version`);
  }

  for (const state of await loadVersionStates()) {
    if (state.currentVersionId || state.contentLength === 0) continue;
    const doc = store.sources.find(s => s.id === state.id);
    if (doc) {
      doc.status = "Paused";
      doc.vectorsCount = 0;
    }
    console.warn(`[sources] "${state.name}" has no servable version — queued for rebuild`);
  }

  // Strategy config
  const savedCfg = await loadConfig();
  if (savedCfg) {
    const merged = { ...DEFAULT_STRATEGY_CONFIG, ...savedCfg } as typeof DEFAULT_STRATEGY_CONFIG & { chunkOverlapUnit?: string };
    // Older builds stored chunkOverlap as a token count while the dashboard
    // labelled it a percentage. Convert once so the effective overlap is kept.
    if (merged.chunkOverlapUnit !== "percent") {
      const legacyTokens = Number((savedCfg as Record<string, unknown>).chunkOverlap ?? 15);
      const percent = Math.max(0, Math.min(50, Math.round((legacyTokens / Math.max(1, merged.chunkSize)) * 100)));
      merged.chunkOverlap = percent;
      merged.chunkOverlapUnit = "percent";
      await saveConfig(merged as unknown as Record<string, unknown>);
      console.log(`[config] migrated chunkOverlap ${legacyTokens} tokens → ${percent}%`);
    }
    // Clause-aware chunking is the point of this deployment (制度/合同), but a
    // stored "Recursive"/"Semantic" from an older build was never a deliberate
    // choice for this corpus. Migrate once, then leave the operator's later
    // choice alone (the marker records that the migration already happened).
    if ((savedCfg as Record<string, unknown>).chunkStrategyMigrated !== true) {
      if (merged.separationStrategy !== "Clause") {
        console.log(`[config] migrating separation strategy ${merged.separationStrategy} → Clause (re-index to apply)`);
      }
      merged.separationStrategy = "Clause";
      (merged as unknown as Record<string, unknown>).chunkStrategyMigrated = true;
      await saveConfig(merged as unknown as Record<string, unknown>);
    }
    store.strategyConfig = merged as typeof DEFAULT_STRATEGY_CONFIG;
    console.log("[config] Loaded strategy config from DB");
  } else {
    store.strategyConfig = { ...DEFAULT_STRATEGY_CONFIG };
    await saveConfig(store.strategyConfig as unknown as Record<string, unknown>);
    console.log("[config] Seeded default strategy config to DB");
  }

  // Re-embed documents with no servable version in the background: startup must
  // not block on the embedding server, and a failure leaves the document
  // rebuildable instead of gone.
  void rebuildMissingVersions();

  // Agent keys
  const keyCount = await countAgentKeys();
  if (keyCount === 0) {
    for (const k of SEED_AGENT_KEYS) {
      await upsertAgentKey({ ...k, monthStamp: k._monthStamp });
    }
    console.log("[agent-keys] Seeded demo key to DB");
  }
  const dbKeys = await loadAgentKeys();
  store.agentKeys = dbKeys.map(k => ({ ...k, keyPreview: maskKey(k.key), _monthStamp: k.monthStamp }));
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

// ── OpenAPI for the public agent surface ───────────────────────────────
const OPENAPI = {
  openapi: "3.0.3",
  info: {
    title: "MarmotRAG Agent API",
    version: "1.1.0",
    description:
      "Versioned knowledge base for agents: chunk + embed + store with clause-aware " +
      "citations, controlled updates (optimistic concurrency), as-of retrieval, and " +
      "usage feedback. Authenticate with X-API-Key.",
  },
  paths: {
    "/api/agent/sources/{id}": {
      get: {
        summary: "Read one document with its current version",
        description: "Returns content plus versionNo, contentSha256, kind, docNo and validity dates. Use it before an update to obtain the current version.",
        security: [{ ApiKeyAuth: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": { description: "Document detail" },
          "404": { description: "Not found or not visible to this key" },
        },
      },
    },
    "/api/agent/sources": {
      post: {
        summary: "Create or update a document (versioned upsert)",
        description:
          "Creates version 1 when the id is new (201). To update an existing document send " +
          "expectedVersion (or If-Match) equal to its current versionNo; the new content " +
          "becomes version N+1 and the previous version stops being served (200). A stale " +
          "expectedVersion returns 409 with the current version. Identical content updates " +
          "metadata/validity in place without re-embedding.",
        security: [{ ApiKeyAuth: [] }],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  id: { type: "string", description: "Stable document id (letters, digits, . _ -)" },
                  name: { type: "string" },
                  type: { type: "string", description: "Free-form source type label" },
                  content: { type: "string", description: "Text to chunk and embed" },
                  expectedVersion: { type: "integer", description: "Required for updates; enables optimistic concurrency" },
                  kind: { type: "string", enum: ["policy", "process", "contract", "template", "annex", "memory", "document"] },
                  docNo: { type: "string", description: "文号 / 合同编号" },
                  lifecycle: { type: "string", enum: ["effective", "draft", "expired", "revoked"] },
                  effectiveFrom: { type: "string", format: "date-time" },
                  effectiveTo: { type: "string", format: "date-time" },
                  signedAt: { type: "string", format: "date-time" },
                },
                required: ["content"],
              },
            },
          },
        },
        responses: {
          "200": { description: "Updated (new version, or metadata-only)" },
          "201": { description: "Created" },
          "400": { description: "Invalid content, id, kind, lifecycle or dates" },
          "401": { description: "Missing or invalid X-API-Key" },
          "409": { description: "Missing or stale expectedVersion" },
          "413": { description: "content too large" },
          "429": { description: "Rate limit exceeded" },
          "500": { description: "Embedding failed (the previous version keeps serving)" },
        },
      },
    },
    "/api/agent/retrieve": {
      post: {
        summary: "Retrieve citable chunks",
        security: [{ ApiKeyAuth: [] }],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  query: { type: "string" },
                  topK: { type: "number", description: "1-50, default 5" },
                  minScore: { type: "number", description: "0-1, default 0" },
                  sourceFilter: { type: "array", items: { type: "string" } },
                  kinds: { type: "array", items: { type: "string" } },
                  docIds: { type: "array", items: { type: "string" } },
                  asOf: { type: "string", format: "date-time", description: "Retrieve the version effective at that moment" },
                  includeExpired: { type: "boolean" },
                  mode: { type: "string", enum: ["fast", "balanced", "deep"] },
                  diversity: { type: "number", description: "0 = relevance only, 1 = maximum diversity" },
                },
                required: ["query"],
              },
            },
          },
        },
        responses: {
          "200": { description: "citations[], context, status (hit|weak|empty), retrievalId, diagnostics" },
          "401": { description: "Missing or invalid X-API-Key" },
          "429": { description: "Rate limit exceeded" },
        },
      },
    },
    "/api/agent/feedback": {
      post: {
        summary: "Report which citations were used and whether they held up",
        security: [{ ApiKeyAuth: [] }],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  retrievalId: { type: "string" },
                  usedCitationIds: { type: "array", items: { type: "string" }, description: "e.g. [\"c1\",\"c3\"]" },
                  verdict: { type: "string", enum: ["grounded", "partial", "unsupported"] },
                  missingInfo: { type: "string" },
                },
                required: ["retrievalId", "verdict"],
              },
            },
          },
        },
        responses: {
          "201": { description: "Recorded" },
          "400": { description: "Invalid retrievalId or verdict" },
          "404": { description: "Unknown retrievalId" },
        },
      },
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
  res.send(`<!doctype html><html><head><meta charset="utf-8"><title>MarmotRAG Agent API</title></head>
<body style="font-family:system-ui;max-width:720px;margin:40px auto">
<h1>MarmotRAG — Agent API</h1>
<p>OpenAPI: <a href="/api/openapi.json">/api/openapi.json</a></p>
<p>Public endpoints (X-API-Key):</p>
<pre><code>POST /api/agent/sources
X-API-Key: mrmk_...

{ "id": "mem-...", "name": "optional", "content": "text to chunk + embed" }
</code></pre>
<pre><code>POST /api/agent/retrieve
X-API-Key: mrmk_...

{ "query": "...", "topK": 5, "minScore": 0.3 }
</code></pre>
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
    const status = Number((err as { status?: number }).status);
    // body-parser reports client errors (bad JSON, too large) with a 4xx status;
    // collapsing them into 500 hides the real cause from the caller.
    if (status >= 400 && status < 500) {
      console.warn(`[error ${status}]`, err.message);
      res.status(status).json({ error: err.message || "Invalid request." });
      return;
    }
    console.error("[error]", err.stack ?? err.message);
    if ((err as { type?: string }).type === "entity.too.large") {
      res.status(413).json({ error: "File too large. Maximum upload size is 50 MB." });
      return;
    }
    res.status(500).json({ error: "Internal server error." });
  });

  const httpServer = app.listen(PORT, "0.0.0.0", () => {
    console.log(`[server] Listening on port ${PORT}`);
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
