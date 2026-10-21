/**
 * Embedding client — speaks either the Ollama native protocol or the
 * OpenAI-compatible protocol, depending on EMBED_API.
 *
 *   EMBED_API="ollama" (default) → POST {base}/api/embeddings  {model, prompt}
 *                                  ← {embedding: [...]}
 *   EMBED_API="openai"           → POST {base}/embeddings      {model, input}
 *                                  ← {data: [{embedding: [...]}]}
 *
 * The OpenAI-compatible mode works with LM Studio, vLLM, OpenAI, etc.
 * Configuration comes from the environment (.env):
 *   EMBED_BASE_URL / OLLAMA_BASE_URL — API base URL
 *       (for OpenAI-compatible servers include the version prefix, e.g.
 *        http://localhost:1234/v1)
 *   OLLAMA_EMBED_MODEL — model name to embed with (must exist on that server;
 *                        for LM Studio use the model key from /v1/models)
 *   EMBED_API_KEY      — optional bearer token for OpenAI-compatible servers
 *
 * Raw output dimension: 2560
 * Stored dimension: 2000 (truncated — pgvector ivfflat max is 2000 dims)
 * qwen3-embedding uses Matryoshka representation learning, so the first 2000
 * dimensions preserve nearly all semantic information.
 * Context window: 32768 tokens
 * Multilingual: native Chinese (simplified + traditional), English, 100+ languages
 */

// Read env lazily (at call time), NOT at module load: dotenv.config() runs
// after the imports are evaluated, so module-level reads would silently ignore
// .env values and always fall back to the defaults.
function embedBaseUrl(): string {
  return process.env.EMBED_BASE_URL || process.env.OLLAMA_BASE_URL || "http://localhost:11434";
}

/** Ollama model name for embeddings — override with OLLAMA_EMBED_MODEL. */
function embedModel(): string {
  return process.env.OLLAMA_EMBED_MODEL || "qwen3-embedding:4b";
}

/** Which wire protocol the embedding server speaks ("ollama" | "openai"). */
function embedApi(): "ollama" | "openai" {
  return (process.env.EMBED_API || "ollama").trim().toLowerCase() === "openai" ? "openai" : "ollama";
}

/** Optional bearer token (OpenAI-compatible servers only). */
function embedApiKey(): string | undefined {
  const key = process.env.EMBED_API_KEY?.trim();
  return key ? key : undefined;
}

/**
 * Endpoint + protocol the embedding client actually uses right now. Single
 * source of truth for anything that reports embedding settings (health check,
 * dashboard config) so the UI never disagrees with reality.
 */
export function embedRuntimeConfig(): {
  ollamaBaseUrl: string;
  embedModel: string;
  api: "ollama" | "openai";
} {
  return { ollamaBaseUrl: embedBaseUrl(), embedModel: embedModel(), api: embedApi() };
}

/**
 * Probe the embedding server with an endpoint that matches its protocol.
 * Ollama exposes GET /api/tags; OpenAI-compatible servers expose GET /models.
 */
export async function probeEmbeddingServer(timeoutMs = 3000): Promise<boolean> {
  const path = embedApi() === "openai" ? "/models" : "/api/tags";
  try {
    const resp = await fetch(`${embedBaseUrl()}${path}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return resp.ok;
  } catch {
    return false;
  }
}
/**
 * Stored vector dimension.
 *
 * pgvector can only build an HNSW/ivfflat index on `vector` columns up to 2000
 * dimensions (the column itself holds up to 16000). qwen3-embedding returns
 * 2560, so we truncate — Matryoshka representation learning keeps almost all
 * semantic signal in the leading dimensions.
 *
 * Override with EMBED_STORE_DIM. Values above 2000 are accepted (the table is
 * created accordingly) but the HNSW index is skipped, so only exact search is
 * available until you switch to halfvec (HNSW up to 4000 dims, pgvector >= 0.7).
 */
export function storeDim(): number {
  const raw = Number(process.env.EMBED_STORE_DIM ?? 2000);
  const n = Number.isFinite(raw) ? Math.round(raw) : 2000;
  return Math.max(1, Math.min(16000, n));
}

/** True when pgvector can index a `vector(n)` column with HNSW/ivfflat. */
export function canIndexVector(dim: number): boolean {
  return dim > 0 && dim <= 2000;
}

// qwen3-embedding:4b has a 32768 token context window. This cap only applies
// to text that arrives here untruncated (queries, legacy chunks); chunking.ts
// guarantees chunks are <= MAX_CHUNK_CHARS (2000) before they reach us.
const MAX_CHARS = 8000;

/**
 * Sanitize text before embedding:
 * 1. Collapse repeated punctuation (TOC dots "......." → ".") which causes
 *    tokenizer explosion in nomic-embed-text.
 * 2. Hard-cap by character count as a last-resort guard. Chunks are already
 *    split to <= MAX_CHUNK_CHARS, so this should only ever fire for queries.
 */
function sanitizeForEmbed(text: string): string {
  const cleaned = text
    // Collapse 3+ repeated punctuation → single char
    .replace(/([.\-_=*~。·…])\1{2,}/g, "$1")
    // Collapse whitespace runs
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  if (cleaned.length > MAX_CHARS) {
    // Never let this be silent: a truncated input means the stored text and the
    // vector disagree, which later shows up as "retrieved but unanswerable".
    console.warn(
      `[embed] input truncated ${cleaned.length} → ${MAX_CHARS} chars; ` +
      `raise MAX_CHUNK_CHARS or split the caller's text`
    );
    return cleaned.slice(0, MAX_CHARS);
  }
  return cleaned;
}

/**
 * Embed a single text string using Ollama — low-level, no retry.
 * Throws on network / model error.
 */
async function embedTextOnce(text: string): Promise<number[]> {
  const clean = sanitizeForEmbed(text);
  const api = embedApi();
  const baseUrl = embedBaseUrl();
  const model = embedModel();
  const apiKey = embedApiKey();

  const request = api === "openai"
    ? {
        url: `${baseUrl}/embeddings`,
        headers: {
          "Content-Type": "application/json",
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({ model, input: clean }),
      }
    : {
        url: `${baseUrl}/api/embeddings`,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, prompt: clean }),
      };

  const response = await fetch(request.url, {
    method: "POST",
    headers: request.headers,
    body: request.body,
    signal: AbortSignal.timeout(30_000), // 30s timeout per chunk
  });

  if (!response.ok) {
    throw new Error(
      `Embedding request to ${request.url} failed: ${response.status} ${response.statusText}`
    );
  }

  const data = (await response.json()) as {
    embedding?: number[];
    data?: { embedding?: number[] }[];
  };

  // Protocol guard: some servers answer unknown endpoints with HTTP 200 plus an
  // error body (LM Studio does), which would otherwise blow up downstream.
  const embedding = api === "openai" ? data?.data?.[0]?.embedding : data?.embedding;
  if (!Array.isArray(embedding) || embedding.length === 0) {
    throw new Error(
      `Embedding response from ${request.url} contained no vector (EMBED_API="${api}"). ` +
      `Check that EMBED_API matches the server's protocol and that model "${model}" exists there.`
    );
  }

  // Truncate to the stored dimension. pgvector can only index `vector` columns
  // up to 2000 dims with HNSW/ivfflat, so 2560-dim models are cut here.
  const dim = storeDim();
  if (embedding.length > dim) return embedding.slice(0, dim);
  if (embedding.length < dim) {
    throw new Error(
      `Embedding dimension ${embedding.length} is smaller than EMBED_STORE_DIM=${dim}. ` +
      `Set EMBED_STORE_DIM to ${embedding.length} (or lower) and restart.`
    );
  }
  return embedding;
}

/**
 * Embed a single text with exponential-backoff retry (up to 3 attempts).
 * Retry delays: 1s → 2s → 4s.
 * Use this for all production embedding calls.
 */
export async function embedText(text: string, maxRetries = 3): Promise<number[]> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await embedTextOnce(text);
    } catch (err) {
      lastErr = err;
      if (attempt < maxRetries - 1) {
        const delayMs = 1000 * Math.pow(2, attempt); // 1s, 2s, 4s
        console.warn(`[embed] attempt ${attempt + 1} failed, retrying in ${delayMs}ms: ${err}`);
        await new Promise(r => setTimeout(r, delayMs));
      }
    }
  }
  throw lastErr;
}

/**
 * Embed multiple texts with bounded concurrency (default: 3 at a time).
 * Returns an array of embeddings in the same order as the input.
 * Each embed uses retry logic via embedText().
 */
export async function embedTexts(texts: string[], concurrency = 3): Promise<number[][]> {
  const results: (number[] | null)[] = new Array(texts.length).fill(null);
  let idx = 0;

  async function worker(): Promise<void> {
    while (true) {
      const i = idx++;
      if (i >= texts.length) break;
      results[i] = await embedText(texts[i]);
    }
  }

  // Spin up `concurrency` workers
  const workers: Promise<void>[] = [];
  for (let w = 0; w < Math.min(concurrency, texts.length); w++) {
    workers.push(worker());
  }
  await Promise.all(workers);

  return results as number[][];
}
