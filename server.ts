import express from "express";
import path from "path";
import dotenv from "dotenv";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, Type } from "@google/genai";

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

// Seed Initial Data Sources (including a document with real HTML and hotlinked images)
let dataSources: SourceDoc[] = [
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
    chunks: []
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
    chunks: []
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
    chunks: []
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
    chunks: []
  }
];

// Helper to generate a mock embedding vector if Gemini isn't configured
function generateMockVector(text: string): number[] {
  const hash = text.split("").reduce((acc, char) => acc + char.charCodeAt(0), 0);
  const vector: number[] = [];
  for (let i = 0; i < 64; i++) {
    vector.push(Math.sin(hash + i) * 0.5 + 0.5);
  }
  return vector;
}

// Calculate Cosine Similarity between two vectors
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

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

// Initial chunk generation for seed data
async function initializeSeedChunks() {
  for (const doc of dataSources) {
    if (doc.chunks.length === 0) {
      const rawChunks = chunkText(doc.content, 120, 15, "Semantic");
      doc.chunks = rawChunks.map((text, idx) => ({
        id: `${doc.id}-chk-${idx}`,
        sourceId: doc.id,
        sourceName: doc.name,
        text,
        tokensCount: text.split(/\s+/).length,
        embedding: generateMockVector(text)
      }));
    }
  }
}
initializeSeedChunks();

// Strategy Config State
let strategyConfig = {
  chunkSize: 512,
  chunkOverlap: 15,
  separationStrategy: "Semantic",
  vectorProvider: "Pinecone (Vector DB)",
  apiEndpoint: "https://alpha-rag-8821.pinecone.io",
  environment: ["us-east-1-aws", "gcp-starter"],
  ssoEnabled: true,
  providerList: [
    { name: "OpenAI", active: true, model: "text-embedding-3-small", status: "Operational" },
    { name: "Azure AI Search", active: false, model: "Vector Indexing", status: "Configured" }
  ]
};

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

// Get health check
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", geminiActive: !!getAI() });
});

// Get data sources
app.get("/api/sources", (req, res) => {
  res.json(dataSources);
});

// Add a new document and chunk it in real-time
app.post("/api/sources", async (req, res) => {
  const { name, content, type } = req.body;
  if (!name || !content) {
    res.status(400).json({ error: "Name and content are required." });
    return;
  }

  const id = `src-${Date.now()}`;
  const docChunks = chunkText(
    content,
    strategyConfig.chunkSize || 120,
    strategyConfig.chunkOverlap || 15,
    strategyConfig.separationStrategy || "Semantic"
  );

  const newDoc: SourceDoc = {
    id,
    name,
    type: type || "Text Document",
    status: "Synced",
    lastSync: "Just now",
    vectorsCount: docChunks.length,
    owner: "You",
    ownerAvatar: "https://lh3.googleusercontent.com/aida-public/AB6AXuCUZfI40ZWgWIDJa9qAzScBenlksgTyw_ZjF1AYj9rj4vCTl6wZxKDgFBZpZlSBlYev_bfIafWaYRsnrWPZBoAc0ZbuwqbkwPXveoPjiO_YWKUF0Y4kefUnFCO6PdAN3kzoe6izqFyK2vK5zfYVlcZPQJdAgJshkBloQ6ERj6IhwjyffFbxRfbjqH03mzWd_9zHkPUEefX1dr6O20QnzW3vjN2U23n40Nt2nVNcnYrymJjWwbdsGeaa",
    content,
    chunks: []
  };

  const ai = getAI();
  const chunksData: Chunk[] = [];

  for (let i = 0; i < docChunks.length; i++) {
    const text = docChunks[i];
    let embedding: number[] | undefined = undefined;

    // Call real Gemini Embedding if configured
    if (ai) {
      try {
        const embedRes = await ai.models.embedContent({
          model: "gemini-embedding-2-preview",
          contents: text,
        });
        const resAny = embedRes as any;
        const embObj = resAny.embedding || (Array.isArray(resAny.embeddings) ? resAny.embeddings[0] : resAny.embeddings);
        if (embObj && embObj.values) {
          embedding = embObj.values;
        }
      } catch (err) {
        console.warn("Gemini embedding calculation failed, falling back to mock:", err);
      }
    }

    if (!embedding) {
      embedding = generateMockVector(text);
    }

    chunksData.push({
      id: `${id}-chk-${i}`,
      sourceId: id,
      sourceName: name,
      text,
      tokensCount: text.split(/\s+/).length,
      embedding
    });
  }

  newDoc.chunks = chunksData;
  newDoc.vectorsCount = chunksData.length;
  dataSources.unshift(newDoc);

  res.json(newDoc);
});

// Perform RAG Search & Context-Grounded Query Answering
app.post("/api/query", async (req, res) => {
  const { query, pipeline } = req.body;
  if (!query) {
    res.status(400).json({ error: "Query is required" });
    return;
  }

  const startTime = Date.now();
  let queryEmbedding: number[] | undefined = undefined;

  const ai = getAI();

  // Call real Gemini Embedding for the Query
  if (ai) {
    try {
      const embedRes = await ai.models.embedContent({
        model: "gemini-embedding-2-preview",
        contents: query,
      });
      const resAny = embedRes as any;
      const embObj = resAny.embedding || (Array.isArray(resAny.embeddings) ? resAny.embeddings[0] : resAny.embeddings);
      if (embObj && embObj.values) {
        queryEmbedding = embObj.values;
      }
    } catch (err) {
      console.warn("Failed query embedding via Gemini, falling back:", err);
    }
  }

  if (!queryEmbedding) {
    queryEmbedding = generateMockVector(query);
  }

  // Calculate similarity against all chunks
  const scoredChunks: { chunk: Chunk; similarity: number }[] = [];
  for (const doc of dataSources) {
    // Skip doc if paused or error (simulates realistic system state)
    if (doc.status === "Paused" || doc.status === "Auth Error") continue;

    for (const chunk of doc.chunks) {
      if (chunk.embedding) {
        const score = cosineSimilarity(queryEmbedding, chunk.embedding);
        scoredChunks.push({ chunk, similarity: score });
      }
    }
  }

  // Sort by similarity and get top 3 context chunks
  scoredChunks.sort((a, b) => b.similarity - a.similarity);
  const topResults = scoredChunks.slice(0, 3);

  // If no chunks matched or database is empty, return empty context
  const retrievedContext = topResults
    .map((res, i) => `[Document ${i + 1}: ${res.chunk.sourceName}] \n${res.chunk.text}`)
    .join("\n\n");

  let ragAnswer = "";
  let faithfulnessScore = 90;
  let relevanceScore = 85;

  if (ai) {
    try {
      // Prompt Gemini to answer based ONLY on the retrieved chunks
      const userPrompt = `
You are a highly analytical RAG Retrieval QA System.
Below is the User's Query and the Retrieved Context Chunks from the document database.

USER QUERY:
"${query}"

RETRIEVED CONTEXT CHUNKS:
${retrievedContext || "NO RELEVANT CONTEXT FOUND"}

INSTRUCTIONS:
1. Answer the query truthfully based ONLY on the retrieved context chunks.
2. Cite your sources using bracketed notations like [Q3 Financial Reports], [Customer Support Docs], or [Enterprise Network Topology].
3. Ensure absolute accuracy. Do not make up facts.
4. If any retrieved context chunk contains an HTML <img> tag (e.g. <img src="..." alt="..." />) or markdown image tag, you MUST preserve it and include it inside your generated 'answer' at the exact logical point where it explains the context. Do not omit the 'src' or 'alt' attributes.
5. Evaluate yourself and provide:
   - "faithfulnessScore" (0-100): How strictly supported the answer is by the context.
   - "relevanceScore" (0-100): How well the context matched the query intent.

Format your exact response as a strict JSON structure:
{
  "answer": "your fully formatted context-grounded answer here (which can contain paragraphs, HTML <img> tags, and list items)",
  "faithfulnessScore": 95,
  "relevanceScore": 90
}
`;

      const response = await ai.models.generateContent({
        model: "gemini-3.5-flash",
        contents: userPrompt,
        config: {
          systemInstruction: "You are an AI system that executes context-grounded RAG query answering and system evaluation, returning strictly compliant JSON.",
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              answer: { type: Type.STRING },
              faithfulnessScore: { type: Type.INTEGER },
              relevanceScore: { type: Type.INTEGER }
            },
            required: ["answer", "faithfulnessScore", "relevanceScore"]
          }
        }
      });

      const responseText = response.text;
      if (responseText) {
        const parsed = JSON.parse(responseText.trim());
        ragAnswer = parsed.answer;
        faithfulnessScore = parsed.faithfulnessScore;
        relevanceScore = parsed.relevanceScore;
      }
    } catch (err) {
      console.error("Gemini context answer generation failed:", err);
      ragAnswer = `Failed to generate response using Gemini. Here is the context retrieved: \n\n${retrievedContext || "No context found."}`;
    }
  }

  // Fallback if Gemini key is missing or failed completely
  if (!ragAnswer) {
    if (topResults.length > 0) {
      // Check if top result contains image, if so, preserve it!
      const topText = topResults[0].chunk.text;
      ragAnswer = `[Offline Mode Response] Based on the context found in "${topResults[0].chunk.sourceName}": \n\n${topText}\n\n(Configure your GEMINI_API_KEY in Settings > Secrets for full AI reasoning and generation capabilities!)`;
      faithfulnessScore = 95;
      relevanceScore = 80;
    } else {
      ragAnswer = "No context was found matching your query in the active vector database. Please upload or activate documents in the Knowledge Base first.";
      faithfulnessScore = 100;
      relevanceScore = 10;
    }
  }

  const latencyMs = Date.now() - startTime;
  const status = faithfulnessScore > 85 ? "success" : "warning";

  const newLog: QueryLog = {
    id: `log-${Date.now()}`,
    timestamp: new Date().toLocaleTimeString("en-US", { hour12: false }),
    query,
    pipeline: pipeline || "Default-Pipeline",
    answer: ragAnswer,
    faithfulnessScore,
    relevanceScore,
    latencyMs,
    status,
    retrievedChunks: topResults.map(res => ({
      text: res.chunk.text,
      sourceName: res.chunk.sourceName,
      score: Math.round(res.similarity * 100) / 100
    }))
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
