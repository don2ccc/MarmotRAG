import express from "express";
import path from "path";
import dotenv from "dotenv";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, Type } from "@google/genai";
import { initDb, upsertChunk, searchChunks, deleteChunksBySource, upsertSource, loadSources, deleteSource, countSources } from "./src/db.js";
import { embedText } from "./src/embeddings.js";
// pdf-parse v1 is CJS; access the function via .default when loaded as ESM
import { createRequire } from "module";
const _require = createRequire(import.meta.url);
const pdfParse: (buffer: Buffer) => Promise<{ text: string; numpages: number }> = _require("pdf-parse");

dotenv.config();

const app = express();
const PORT = 3000;

app.use(express.json({ limit: "50mb" }));

// Lazy-loaded Gemini AI client to handle missing keys gracefully on startup
let aiClient: GoogleGenAI | null = null;
function getAI(): GoogleGenAI | null {
  if (!aiClient) {
    const key = process.env.GEMINI_API_KEY;
    if (key && key !== "MY_GEMINI_API_KEY") {
      aiClient = new GoogleGenAI({
        apiKey: key,
        httpOptions: {
          headers: {
            "User-Agent": "aistudio-build",
          },
        },
      });
    }
  }
  return aiClient;
}

// In-Memory Data Store for RAG System
interface Chunk {
  id: string;
  sourceId: string;
  sourceName: string;
  text: string;
  tokensCount: number;
  embedding?: number[];
}

interface SourceDoc {
  id: string;
  name: string;
  type: string; // PDF Collection, Notion Webhook, G-Drive Archive, HTML Document, etc.
  status: "Synced" | "Syncing..." | "Paused" | "Auth Error";
  lastSync: string;
  vectorsCount: number;
  owner: string;
  ownerAvatar?: string;
  content: string;
  chunks: Chunk[];
}

interface QueryLog {
  id: string;
  timestamp: string;
  query: string;
  pipeline: string;
  answer: string;
  faithfulnessScore: number;
  relevanceScore: number;
  latencyMs: number;
  status: "success" | "warning" | "error";
  retrievedChunks: { text: string; sourceName: string; score: number }[];
}

// dataSources is populated from DB at startup by initializeSources()
let dataSources: SourceDoc[] = [];

// Seed documents — written to DB only when marmot_sources is empty (first run ever)
const SEED_SOURCES: Omit<SourceDoc, "chunks">[] = [
  {
    id: "src-1",
    name: "Q3 Financial Reports",
    type: "PDF Collection",
    status: "Synced",
    lastSync: "2 hours ago",
    vectorsCount: 24510,
    owner: "You",
    ownerAvatar: "https://lh3.googleusercontent.com/aida-public/AB6AXuCUZfI40ZWgWIDJa9qAzScBenlksgTyw_ZjF1AYj9rj4vCTl6wZxKDgFBZpZlSBlYev_bfIafWaYRsnrWPZBoAc0ZbuwqbkwPXveoPjiO_YWKUF0Y4kefUnFCO6PdAN3kzoe6izqFyK2vK5zfYVlcZPQJdAgJshkBloQ6ERj6IhwjyffFbxRfbjqH03mzWd_9zHkPUEefX1dr6O20QnzW3vjN2U23n40Nt2nVNcnYrymJjWwbdsGeaa",
    content: "RAG Enterprise Financial Report for Q3 2026. Revenues increased by 15.4% quarter-over-quarter, reaching a historic high of $42.6 million. Operation costs were kept under control, decreasing overall system latency and optimizing API credit costs. Standard compliance was fully met across tier 3 data center regions.",
  },
  {
    id: "src-2",
    name: "Customer Support Docs",
    type: "Notion Webhook",
    status: "Synced",
    lastSync: "In progress",
    vectorsCount: 102933,
    owner: "You",
    ownerAvatar: "https://lh3.googleusercontent.com/aida-public/AB6AXuCUZfI40ZWgWIDJa9qAzScBenlksgTyw_ZjF1AYj9rj4vCTl6wZxKDgFBZpZlSBlYev_bfIafWaYRsnrWPZBoAc0ZbuwqbkwPXveoPjiO_YWKUF0Y4kefUnFCO6PdAN3kzoe6izqFyK2vK5zfYVlcZPQJdAgJshkBloQ6ERj6IhwjyffFbxRfbjqH03mzWd_9zHkPUEefX1dr6O20QnzW3vjN2U23n40Nt2nVNcnYrymJjWwbdsGeaa",
    content: "Customer support rules require a Microsoft Entra or Okta Single Sign-On (SSO) for authentication. Secondary work policy states that employees must request written super-admin permission before taking on external development work to ensure there is no IP collision. Latency fallback mode switches automatically to the Azure AI Search vector database if primary Pinecone API response latency exceeds 500ms.",
  },
  {
    id: "src-4",
    name: "Enterprise Network Topology",
    type: "HTML Document",
    status: "Synced",
    lastSync: "10 mins ago",
    vectorsCount: 1820,
    owner: "Alex Rivera",
    ownerAvatar: "https://lh3.googleusercontent.com/aida-public/AB6AXuCB2V1AmGB2QbpzGRmdTc18v779hBGHKc1XGY8-Tpe7PrKvpkCdqOFrI1pw_sIYLXkPDjNchTSKlost7smglEjdkzy6No1nert4fbpnFrDfRqiO_tMkpJjEO2PzT8is4UvqykK3WS4i6GkycezERUIXIsjY9nR8zSPs5WHArO3G94M59wruvEas2lEFdmYnexWRGf70prB2z0tEmcjgXK5JNiXGZnuRm5cC3Qb6W6L1LcdXplXa3wE9",
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
    status: "Paused",
    lastSync: "3 days ago",
    vectorsCount: 8244,
    owner: "Sarah K.",
    ownerAvatar: "https://lh3.googleusercontent.com/aida-public/AB6AXuD9HiY5NXFEBD_jBLR73RLjTyaUuFkDAGR3xP45-msTAdfseUcPIVX0SS4ejT1-XF2B_luIUE6VXsMGuS3H8DSPhjSJOGGsiluZx402_Z0BYp3hVYPxeAAMU0ijY_jHSqiS5TNzWVOU2pdDf4XaKCgb6RS5rpQsEnkH_QmFpPzOLPOtugVzF_Y5fAz5y3NHrjVH4B_EC1a0LlLRP2PNe4j_ayPjlsjDDo3V5vtPws9Awsjw3bAeJHma",
    content: "The original System-900 series utilizes fixed-size chunks of 256 tokens and 10% overlap. This legacy setting is now retired but documentation is kept for regulatory compliance. System-900 compliance rules dictate strict air-gapped deployments for public sector clients.",
  },
];

// Custom text chunking helper
function chunkText(text: string, size: number, overlap: number, strategy: string): string[] {
  const words = text.split(/\s+/);
  const chunks: string[] = [];
  
  if (strategy === "Fixed" || words.length < size / 2) {
    // Basic character or word-based sliding window
    const stride = Math.max(1, Math.floor(size * (1 - overlap / 100)));
    for (let i = 0; i < words.length; i += stride) {
      const chunkWords = words.slice(i, i + size);
      if (chunkWords.length > 0) {
        chunks.push(chunkWords.join(" "));
      }
      if (i + size >= words.length) break;
    }
  } else if (strategy === "Semantic") {
    // Semantic sentence-boundary sliding window (treats HTML tags as parts of sentences)
    const sentences = text.match(/[^.!?]+[.!?]+(\s|$)/g) || [text];
    let currentChunk: string[] = [];
    let currentLen = 0;
    
    for (const sentence of sentences) {
      const sentenceLen = sentence.split(/\s+/).length;
      if (currentLen + sentenceLen > size && currentChunk.length > 0) {
        chunks.push(currentChunk.join(" "));
        // Apply overlap (retain last few sentences)
        const overlapLimit = Math.max(1, Math.floor(size * (overlap / 100)));
        let overlapLen = 0;
        const overlapChunk: string[] = [];
        for (let j = currentChunk.length - 1; j >= 0; j--) {
          const wCount = currentChunk[j].split(/\s+/).length;
          if (overlapLen + wCount <= overlapLimit) {
            overlapChunk.unshift(currentChunk[j]);
            overlapLen += wCount;
          } else {
            break;
          }
        }
        currentChunk = overlapChunk;
        currentLen = overlapLen;
      }
      currentChunk.push(sentence.trim());
      currentLen += sentenceLen;
    }
    if (currentChunk.length > 0) {
      chunks.push(currentChunk.join(" "));
    }
  } else {
    // Recursive: Split by paragraphs first
    const paragraphs = text.split(/\n\s*\n+/);
    for (const para of paragraphs) {
      if (para.split(/\s+/).length <= size) {
        chunks.push(para.trim());
      } else {
        // Fallback to fixed chunking for huge paragraphs
        const subChunks = chunkText(para, size, overlap, "Fixed");
        chunks.push(...subChunks);
      }
    }
  }
  return chunks.filter(c => c.trim().length > 0);
}

/**
 * Load sources from DB into dataSources memory array.
 * On first run (empty table) write the seed documents and embed their chunks.
 */
async function initializeSources() {
  const existing = await countSources();
  if (existing === 0) {
    console.log("[sources] Empty DB — seeding initial documents...");
    for (const doc of SEED_SOURCES) {
      await upsertSource({ ...doc, ownerAvatar: doc.ownerAvatar ?? "" });
      // Embed seed chunks
      const rawChunks = chunkText(doc.content, 120, 15, "Semantic");
      for (let idx = 0; idx < rawChunks.length; idx++) {
        const text = rawChunks[idx];
        try {
          const embedding = await embedText(text);
          await upsertChunk({ id: `${doc.id}-chk-${idx}`, sourceId: doc.id, sourceName: doc.name, text, tokensCount: text.split(/\s+/).length, embedding });
        } catch (err) {
          console.warn(`[seed] embed failed for ${doc.id}-chk-${idx}:`, err);
        }
      }
      console.log(`[seed] Embedded: ${doc.name}`);
    }
  }
  // Always load from DB into memory; cast status string → union literal
  const rows = await loadSources();
  dataSources = rows.map(r => ({
    ...r,
    status: r.status as SourceDoc["status"],
    chunks: [],
  }));
  console.log(`[sources] Loaded ${dataSources.length} source(s) from DB`);
}

// Strategy Config State
let strategyConfig = {
  chunkSize: 512,
  chunkOverlap: 15,
  separationStrategy: "Semantic",
  // Vector store — actual local pgvector config (read from env)
  pgHost: process.env.PG_HOST || "127.0.0.1",
  pgPort: process.env.PG_PORT || "5432",
  pgDatabase: process.env.PG_DATABASE || "ai_hub",
  pgTable: "marmot_chunks",
  // Embedding model — Ollama local
  embeddingProvider: "Ollama (Local)",
  embeddingModel: "nomic-embed-text:latest",
  embeddingDimension: 768,
  ollamaBaseUrl: process.env.OLLAMA_BASE_URL || "http://localhost:11434",
  // Auth
  ssoEnabled: true,
  providerList: [
    { name: "Ollama", active: true, model: "nomic-embed-text:latest", status: "Local" },
    { name: "Gemini Generation", active: !!process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== "MY_GEMINI_API_KEY", model: "gemini-3.5-flash", status: "Generation Only" }
  ],
  // Optional external / cloud vector DB — disabled by default
  externalVectorDb: {
    enabled: false,
    provider: "Pinecone",
    apiEndpoint: "",
    apiKey: "",
    indexName: "",
    notes: "",
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline Store
// ─────────────────────────────────────────────────────────────────────────────
interface Pipeline {
  id: string;
  name: string;
  description: string;
  generationModel: string;
  topK: number;
  minScore: number;
  systemPrompt: string;
  sourceFilter: string[];
  enabled: boolean;
  createdAt: string;
}

const DEFAULT_SYSTEM_PROMPT = "You are an AI system that executes context-grounded RAG query answering and system evaluation, returning strictly compliant JSON.";

let pipelines: Pipeline[] = [
  {
    id: "pipe-1",
    name: "Doc-Search-Alpha",
    description: "General-purpose document retrieval. Optimised for speed and broad coverage.",
    generationModel: "gemini-3.5-flash",
    topK: 3,
    minScore: 0.0,
    systemPrompt: "",
    sourceFilter: [],
    enabled: true,
    createdAt: new Date(Date.now() - 86400000 * 7).toISOString(),
  },
  {
    id: "pipe-2",
    name: "Legal-Brief-Retriever",
    description: "High-precision pipeline for legal and compliance documents. Filters low-confidence chunks.",
    generationModel: "gemini-3.5-flash",
    topK: 5,
    minScore: 0.6,
    systemPrompt: "You are a legal analyst. Answer with precise citations and conservative language.",
    sourceFilter: [],
    enabled: true,
    createdAt: new Date(Date.now() - 86400000 * 3).toISOString(),
  },
  {
    id: "pipe-3",
    name: "Customer-Support-LLM",
    description: "Customer-facing support assistant. Returns friendly, concise answers.",
    generationModel: "gemini-3.5-flash",
    topK: 3,
    minScore: 0.3,
    systemPrompt: "You are a helpful customer support agent. Be friendly, concise, and always suggest next steps.",
    sourceFilter: [],
    enabled: false,
    createdAt: new Date(Date.now() - 86400000 * 1).toISOString(),
  },
];

/** Compute live stats for all pipelines from the query log. */
function computePipelineStats(): Record<string, {
  queryCount: number; avgLatencyMs: number; avgFaithfulness: number; avgRelevance: number; lastUsed: string | null;
}> {
  const stats: Record<string, { count: number; latSum: number; faithSum: number; relSum: number; lastUsed: string | null }> = {};
  for (const log of queryLogs) {
    if (!stats[log.pipeline]) stats[log.pipeline] = { count: 0, latSum: 0, faithSum: 0, relSum: 0, lastUsed: null };
    const s = stats[log.pipeline];
    s.count++;
    s.latSum += log.latencyMs;
    s.faithSum += log.faithfulnessScore;
    s.relSum += log.relevanceScore;
    if (!s.lastUsed) s.lastUsed = log.timestamp;
  }
  const result: Record<string, { queryCount: number; avgLatencyMs: number; avgFaithfulness: number; avgRelevance: number; lastUsed: string | null }> = {};
  for (const [name, s] of Object.entries(stats)) {
    result[name] = {
      queryCount: s.count,
      avgLatencyMs: Math.round(s.latSum / s.count),
      avgFaithfulness: Math.round(s.faithSum / s.count),
      avgRelevance: Math.round(s.relSum / s.count),
      lastUsed: s.lastUsed,
    };
  }
  return result;
}

// System Query Logs State
let queryLogs: QueryLog[] = [
  {
    id: "log-1",
    timestamp: "14:22:18",
    query: "What are the compliance rules for Tier 3 data centers?",
    pipeline: "Doc-Search-Alpha",
    answer: "Revenues increased by 15.4% quarter-over-quarter, and standard compliance was fully met across tier 3 data center regions for regulatory operations.",
    faithfulnessScore: 99,
    relevanceScore: 96,
    latencyMs: 182,
    status: "success",
    retrievedChunks: [
      { text: "Standard compliance was fully met across tier 3 data center regions.", sourceName: "Q3 Financial Reports", score: 0.95 }
    ]
  },
  {
    id: "log-2",
    timestamp: "14:20:02",
    query: "Retrieve corporate regulations on secondary development work.",
    pipeline: "Legal-Brief-Retriever",
    answer: "According to the corporate policy, employees must request written super-admin permission before taking on external development work to avoid intellectual property or IP collisions.",
    faithfulnessScore: 94,
    relevanceScore: 91,
    latencyMs: 315,
    status: "success",
    retrievedChunks: [
      { text: "Secondary work policy states that employees must request written super-admin permission before taking on external development work to ensure there is no IP collision.", sourceName: "Customer Support Docs", score: 0.88 }
    ]
  },
  {
    id: "log-3",
    timestamp: "14:18:45",
    query: "Show me the distribution of our database cluster diagram.",
    pipeline: "Doc-Search-Alpha",
    answer: "Our primary database cluster is distributed across multiple regions to ensure high availability. The connection topology and physical server layout is detailed in the diagram below:\n\n<img src=\"https://images.unsplash.com/photo-1558494949-ef010cbdcc31?auto=format&fit=crop&w=800&q=80\" alt=\"Enterprise Network Topology Diagram\" />",
    faithfulnessScore: 95,
    relevanceScore: 92,
    latencyMs: 245,
    status: "success",
    retrievedChunks: [
      { text: "Our primary database cluster is distributed across multiple regions to ensure high availability. <img src=\"https://images.unsplash.com/photo-1558494949-ef010cbdcc31?auto=format&fit=crop&w=800&q=80\" alt=\"Enterprise Network Topology Diagram\" />", sourceName: "Enterprise Network Topology", score: 0.92 }
    ]
  }
];

// Active User List
let users = [
  { id: "u-1", name: "Jane Doe", email: "jane.doe@enterprise.ai", role: "Super Admin", lastLogin: "2 mins ago" },
  { id: "u-2", name: "Marcus Kane", email: "m.kane@enterprise.ai", role: "Developer", lastLogin: "3 hours ago" },
  { id: "u-3", name: "Sarah Lim", email: "slim@enterprise.ai", role: "Viewer", lastLogin: "Yesterday" }
];

// --- API Endpoints ---

// Parse a PDF file and return its extracted text
// Body: { base64: string }  (raw base64 of the PDF file, no data-URI prefix needed)
app.post("/api/parse-pdf", async (req, res) => {
  const { base64 } = req.body;
  if (!base64 || typeof base64 !== "string") {
    res.status(400).json({ error: "base64 field is required." });
    return;
  }
  try {
    const buffer = Buffer.from(base64, "base64");
    const data = await pdfParse(buffer);
    // Strip null bytes and other control characters PostgreSQL rejects
    const cleanText = data.text.replace(/\x00/g, "").replace(/[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]/g, " ").trim();
    res.json({ text: cleanText, pages: data.numpages });
  } catch (err) {
    console.error("[parse-pdf] Failed to parse PDF:", err);
    res.status(422).json({ error: "Failed to parse PDF. Make sure the file is a valid PDF." });
  }
});

// Get health check — also probes pgvector and Ollama connectivity
app.get("/api/health", async (req, res) => {
  let pgConnected = false;
  let ollamaConnected = false;

  try {
    await searchChunks(new Array(768).fill(0), 1);
    pgConnected = true;
  } catch { pgConnected = false; }

  try {
    const r = await fetch(`${process.env.OLLAMA_BASE_URL || "http://localhost:11434"}/api/tags`, { signal: AbortSignal.timeout(2000) });
    ollamaConnected = r.ok;
  } catch { ollamaConnected = false; }

  res.json({
    status: "ok",
    geminiActive: !!getAI(),
    pgConnected,
    ollamaConnected,
    pgHost: process.env.PG_HOST || "127.0.0.1",
    pgDatabase: process.env.PG_DATABASE || "ai_hub",
    ollamaBaseUrl: process.env.OLLAMA_BASE_URL || "http://localhost:11434",
  });
});

// Get data sources
app.get("/api/sources", (req, res) => {
  res.json(dataSources);
});

/** Helper: embed all chunks for a doc, streaming SSE progress events. */
async function embedAndStoreChunks(
  docId: string,
  docName: string,
  rawChunks: string[],
  send: (event: string, data: unknown) => void
): Promise<Chunk[]> {
  const chunksData: Chunk[] = [];
  for (let i = 0; i < rawChunks.length; i++) {
    const text = rawChunks[i];
    let embedding: number[];
    try {
      embedding = await embedText(text);
    } catch (err) {
      throw new Error(`Ollama embed failed on chunk ${i}: ${err}`);
    }
    const chunk: Chunk = {
      id: `${docId}-chk-${i}`,
      sourceId: docId,
      sourceName: docName,
      text,
      tokensCount: text.split(/\s+/).length,
      embedding,
    };
    chunksData.push(chunk);
    await upsertChunk(chunk as Required<Chunk>);
    // Push progress event
    send("progress", { done: i + 1, total: rawChunks.length });
  }
  return chunksData;
}

// Add a new document — SSE stream that emits progress while embedding
// Event types: "start" | "progress" | "done" | "error"
app.post("/api/sources", async (req, res) => {
  const { name, content, type } = req.body;
  if (!name || !content) {
    res.status(400).json({ error: "Name and content are required." });
    return;
  }

  // Reject duplicate: same name already exists in dataSources
  const existing = dataSources.find(d => d.name.trim().toLowerCase() === name.trim().toLowerCase());
  if (existing) {
    res.status(409).json({ error: `A document named "${name}" already exists. Delete it first or use Re-index to update it.` });
    return;
  }

  // Set up SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const id = `src-${Date.now()}`;
  const rawChunks = chunkText(
    content,
    strategyConfig.chunkSize || 120,
    strategyConfig.chunkOverlap || 15,
    strategyConfig.separationStrategy || "Semantic"
  );

  const newDoc: SourceDoc = {
    id,
    name,
    type: type || "Text Document",
    status: "Syncing...",
    lastSync: "Just now",
    vectorsCount: rawChunks.length,
    owner: "You",
    ownerAvatar: "https://lh3.googleusercontent.com/aida-public/AB6AXuCUZfI40ZWgWIDJa9qAzScBenlksgTyw_ZjF1AYj9rj4vCTl6wZxKDgFBZpZlSBlYev_bfIafWaYRsnrWPZBoAc0ZbuwqbkwPXveoPjiO_YWKUF0Y4kefUnFCO6PdAN3kzoe6izqFyK2vK5zfYVlcZPQJdAgJshkBloQ6ERj6IhwjyffFbxRfbjqH03mzWd_9zHkPUEefX1dr6O20QnzW3vjN2U23n40Nt2nVNcnYrymJjWwbdsGeaa",
    content,
    chunks: []
  };

  // Persist to DB immediately (status: Syncing...)
  await upsertSource({ id, name, type: newDoc.type, status: newDoc.status, lastSync: newDoc.lastSync, vectorsCount: newDoc.vectorsCount, owner: newDoc.owner, ownerAvatar: newDoc.ownerAvatar ?? "", content });
  dataSources.unshift(newDoc);
  send("start", { doc: { ...newDoc, chunks: [] }, total: rawChunks.length });

  try {
    const chunksData = await embedAndStoreChunks(id, name, rawChunks, send);
    newDoc.chunks = chunksData;
    newDoc.vectorsCount = chunksData.length;
    newDoc.status = "Synced";
    newDoc.lastSync = new Date().toLocaleTimeString("en-US", { hour12: false });
    // Persist final state
    await upsertSource({ id, name, type: newDoc.type, status: "Synced", lastSync: newDoc.lastSync, vectorsCount: newDoc.vectorsCount, owner: newDoc.owner, ownerAvatar: newDoc.ownerAvatar ?? "", content });
    send("done", { doc: { ...newDoc, chunks: [] } });
  } catch (err) {
    newDoc.status = "Auth Error";
    await upsertSource({ id, name, type: newDoc.type, status: "Auth Error", lastSync: newDoc.lastSync, vectorsCount: 0, owner: newDoc.owner, ownerAvatar: newDoc.ownerAvatar ?? "", content });
    send("error", { message: String(err) });
  }

  res.end();
});

// Delete a source document and its pgvector chunks
app.delete("/api/sources/:id", async (req, res) => {
  const { id } = req.params;
  const idx = dataSources.findIndex(d => d.id === id);
  if (idx === -1) { res.status(404).json({ error: "Source not found" }); return; }
  dataSources.splice(idx, 1);
  try {
    await deleteChunksBySource(id);
    await deleteSource(id);
  } catch (err) {
    console.warn("[delete-source] pgvector/source cleanup failed:", err);
  }
  res.json({ message: "Source deleted" });
});

// Re-index (re-chunk + re-embed) an existing source — SSE stream
app.post("/api/sources/:id/reindex", async (req, res) => {
  const { id } = req.params;
  const doc = dataSources.find(d => d.id === id);
  if (!doc) { res.status(404).json({ error: "Source not found" }); return; }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  doc.status = "Syncing...";
  const rawChunks = chunkText(
    doc.content,
    strategyConfig.chunkSize || 120,
    strategyConfig.chunkOverlap || 15,
    strategyConfig.separationStrategy || "Semantic"
  );

  // Remove old chunks from pgvector
  try {
    await deleteChunksBySource(id);
  } catch (err) {
    console.warn("[reindex] pgvector cleanup failed:", err);
  }

  send("start", { doc: { ...doc, chunks: [] }, total: rawChunks.length });

  try {
    const chunksData = await embedAndStoreChunks(id, doc.name, rawChunks, send);
    doc.chunks = chunksData;
    doc.vectorsCount = chunksData.length;
    doc.status = "Synced";
    doc.lastSync = new Date().toLocaleTimeString("en-US", { hour12: false });
    await upsertSource({ id, name: doc.name, type: doc.type, status: "Synced", lastSync: doc.lastSync, vectorsCount: doc.vectorsCount, owner: doc.owner, ownerAvatar: doc.ownerAvatar ?? "", content: doc.content });
    send("done", { doc: { ...doc, chunks: [] } });
  } catch (err) {
    doc.status = "Auth Error";
    await upsertSource({ id, name: doc.name, type: doc.type, status: "Auth Error", lastSync: doc.lastSync, vectorsCount: doc.vectorsCount, owner: doc.owner, ownerAvatar: doc.ownerAvatar ?? "", content: doc.content });
    send("error", { message: String(err) });
  }

  res.end();
});

// ─── Pipeline CRUD ────────────────────────────────────────────────────────────

app.get("/api/pipelines", (req, res) => {
  const stats = computePipelineStats();
  const result = pipelines.map(p => ({
    ...p,
    stats: stats[p.name] ?? { queryCount: 0, avgLatencyMs: 0, avgFaithfulness: 0, avgRelevance: 0, lastUsed: null },
  }));
  res.json(result);
});

app.post("/api/pipelines", (req, res) => {
  const { name, description, generationModel, topK, minScore, systemPrompt, sourceFilter, enabled } = req.body;
  if (!name) { res.status(400).json({ error: "name is required" }); return; }
  const exists = pipelines.find(p => p.name === name);
  if (exists) { res.status(409).json({ error: "Pipeline name already exists" }); return; }
  const p: Pipeline = {
    id: `pipe-${Date.now()}`,
    name,
    description: description || "",
    generationModel: generationModel || "gemini-3.5-flash",
    topK: topK ?? 3,
    minScore: minScore ?? 0.0,
    systemPrompt: systemPrompt || "",
    sourceFilter: sourceFilter || [],
    enabled: enabled ?? true,
    createdAt: new Date().toISOString(),
  };
  pipelines.push(p);
  res.status(201).json(p);
});

app.put("/api/pipelines/:id", (req, res) => {
  const idx = pipelines.findIndex(p => p.id === req.params.id);
  if (idx === -1) { res.status(404).json({ error: "Pipeline not found" }); return; }
  // Prevent renaming to an existing name
  if (req.body.name && req.body.name !== pipelines[idx].name) {
    const clash = pipelines.find(p => p.name === req.body.name);
    if (clash) { res.status(409).json({ error: "Pipeline name already exists" }); return; }
  }
  pipelines[idx] = { ...pipelines[idx], ...req.body, id: pipelines[idx].id, createdAt: pipelines[idx].createdAt };
  res.json(pipelines[idx]);
});

app.delete("/api/pipelines/:id", (req, res) => {
  const idx = pipelines.findIndex(p => p.id === req.params.id);
  if (idx === -1) { res.status(404).json({ error: "Pipeline not found" }); return; }
  pipelines.splice(idx, 1);
  res.json({ message: "Pipeline deleted" });
});

// ─── RAG Query (uses pipeline config) ────────────────────────────────────────

// Perform RAG Search & Context-Grounded Query Answering
app.post("/api/query", async (req, res) => {
  const { query, pipeline: pipelineName } = req.body;
  if (!query) {
    res.status(400).json({ error: "Query is required" });
    return;
  }

  // Resolve pipeline config — fall back to sensible defaults
  const pipelineCfg: Pipeline = pipelines.find(p => p.name === pipelineName && p.enabled)
    ?? pipelines.find(p => p.enabled)
    ?? { id: "default", name: pipelineName || "Default", description: "", generationModel: "gemini-3.5-flash", topK: 3, minScore: 0.0, systemPrompt: "", sourceFilter: [], enabled: true, createdAt: "" };

  const startTime = Date.now();

  // Embed the query via Ollama
  let queryEmbedding: number[];
  try {
    queryEmbedding = await embedText(query);
  } catch (err) {
    console.error("[query] Ollama embed failed:", err);
    res.status(500).json({ error: "Embedding failed. Is Ollama running with nomic-embed-text?" });
    return;
  }

  // Determine sources to exclude
  const excludedIds = dataSources
    .filter(d => d.status === "Paused" || d.status === "Auth Error")
    .map(d => d.id);

  // Apply pipeline sourceFilter (only search specified sources if set)
  const activeSourceIds = pipelineCfg.sourceFilter.length > 0
    ? dataSources.filter(d => pipelineCfg.sourceFilter.includes(d.id) && d.status === "Synced").map(d => d.id)
    : null;

  // Vector search using pipeline topK; post-filter by minScore
  const pgResults = await searchChunks(queryEmbedding, pipelineCfg.topK * 2, excludedIds);
  const filtered = pgResults.filter(r =>
    r.score >= pipelineCfg.minScore &&
    (activeSourceIds === null || activeSourceIds.includes(r.sourceId))
  ).slice(0, pipelineCfg.topK);

  const topResults = filtered.map(r => ({
    chunk: { id: r.id, sourceId: r.sourceId, sourceName: r.sourceName, text: r.text, tokensCount: r.tokensCount } as Chunk,
    similarity: r.score,
  }));

  const retrievedContext = topResults
    .map((res, i) => `[Document ${i + 1}: ${res.chunk.sourceName}] \n${res.chunk.text}`)
    .join("\n\n");

  const ai = getAI();
  let ragAnswer = "";
  let faithfulnessScore = 90;
  let relevanceScore = 85;

  if (ai) {
    try {
      const sysInstruction = pipelineCfg.systemPrompt.trim() || DEFAULT_SYSTEM_PROMPT;
      const userPrompt = `
You are a highly analytical RAG Retrieval QA System.
Below is the User's Query and the Retrieved Context Chunks from the document database.

USER QUERY:
"${query}"

RETRIEVED CONTEXT CHUNKS:
${retrievedContext || "NO RELEVANT CONTEXT FOUND"}

INSTRUCTIONS:
1. Answer the query truthfully based ONLY on the retrieved context chunks.
2. Cite your sources using bracketed notations like [Source Name].
3. Ensure absolute accuracy. Do not make up facts.
4. If any retrieved context chunk contains an HTML <img> tag, preserve it in your answer.
5. Evaluate yourself and provide faithfulnessScore (0-100) and relevanceScore (0-100).

Respond as strict JSON: { "answer": "...", "faithfulnessScore": 95, "relevanceScore": 90 }
`;
      const response = await ai.models.generateContent({
        model: pipelineCfg.generationModel,
        contents: userPrompt,
        config: {
          systemInstruction: sysInstruction,
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: { answer: { type: Type.STRING }, faithfulnessScore: { type: Type.INTEGER }, relevanceScore: { type: Type.INTEGER } },
            required: ["answer", "faithfulnessScore", "relevanceScore"],
          },
        },
      });
      if (response.text) {
        const parsed = JSON.parse(response.text.trim());
        ragAnswer = parsed.answer;
        faithfulnessScore = parsed.faithfulnessScore;
        relevanceScore = parsed.relevanceScore;
      }
    } catch (err) {
      console.error("Gemini generation failed:", err);
      ragAnswer = `Failed to generate response using Gemini. Retrieved context:\n\n${retrievedContext || "No context found."}`;
    }
  }

  if (!ragAnswer) {
    if (topResults.length > 0) {
      ragAnswer = `[Offline Mode] Based on "${topResults[0].chunk.sourceName}":\n\n${topResults[0].chunk.text}\n\n(Configure GEMINI_API_KEY for full AI generation.)`;
      faithfulnessScore = 95; relevanceScore = 80;
    } else {
      ragAnswer = "No context found matching your query. Please upload documents in the Knowledge Base first.";
      faithfulnessScore = 100; relevanceScore = 10;
    }
  }

  const latencyMs = Date.now() - startTime;
  const newLog: QueryLog = {
    id: `log-${Date.now()}`,
    timestamp: new Date().toLocaleTimeString("en-US", { hour12: false }),
    query,
    pipeline: pipelineCfg.name,
    answer: ragAnswer,
    faithfulnessScore,
    relevanceScore,
    latencyMs,
    status: faithfulnessScore > 85 ? "success" : "warning",
    retrievedChunks: topResults.map(r => ({ text: r.chunk.text, sourceName: r.chunk.sourceName, score: Math.round(r.similarity * 100) / 100 })),
  };

  queryLogs.unshift(newLog);
  res.json(newLog);
});

// Get current system config
app.get("/api/config", (req, res) => {
  res.json(strategyConfig);
});

// Update config
app.post("/api/config", (req, res) => {
  strategyConfig = { ...strategyConfig, ...req.body };
  res.json({ message: "Configuration saved successfully", config: strategyConfig });
});

// Get audit/query logs
app.get("/api/logs", (req, res) => {
  res.json(queryLogs);
});

// Get active providers
app.get("/api/providers", (req, res) => {
  res.json(strategyConfig.providerList);
});

// Configure providers
app.post("/api/providers", (req, res) => {
  const { providers } = req.body;
  if (providers) {
    strategyConfig.providerList = providers;
  }
  res.json({ message: "Providers saved", providers: strategyConfig.providerList });
});

// Get users list
app.get("/api/users", (req, res) => {
  res.json(users);
});

// Add user
app.post("/api/users", (req, res) => {
  const { name, email, role } = req.body;
  if (!name || !email) {
    res.status(400).json({ error: "Name and email are required" });
    return;
  }
  const newUser = {
    id: `u-${Date.now()}`,
    name,
    email,
    role: role || "Viewer",
    lastLogin: "Just now"
  };
  users.push(newUser);
  res.json(newUser);
});

// Delete user
app.delete("/api/users/:id", (req, res) => {
  const { id } = req.params;
  users = users.filter(u => u.id !== id);
  res.json({ message: "User deleted" });
});

// Simulate connection test
app.post("/api/test-connectivity", (req, res) => {
  setTimeout(() => {
    res.json({ success: true, message: "Connection to Vector DB succeeded!" });
  }, 1000);
});

// --- Vite setup or production static server ---
async function startServer() {
  // Initialise pgvector tables, then load/seed sources from DB
  await initDb();
  await initializeSources();

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
  });
}

startServer();
