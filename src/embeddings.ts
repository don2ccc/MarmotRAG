/**
 * Local embedding via Ollama qwen3-embedding:4b.
 * Ollama must be running and the model must be pulled:
 *   ollama pull qwen3-embedding:4b
 *
 * Raw output dimension: 2560
 * Stored dimension: 2000 (truncated — pgvector ivfflat max is 2000 dims)
 * qwen3-embedding uses Matryoshka representation learning, so the first 2000
 * dimensions preserve nearly all semantic information.
 * Context window: 32768 tokens
 * Multilingual: native Chinese (simplified + traditional), English, 100+ languages
 */

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
const EMBED_MODEL = "qwen3-embedding:4b";
// pgvector ivfflat hard limit is 2000 dims; truncate the 2560-dim output here.
const STORE_DIM = 2000;

// qwen3-embedding:4b has a 32768 token context window.
// Safe practical cap: 2000 chars for CJK (each char ~1.5 tokens in Qwen tokenizer),
// giving ~3000 tokens — well within the limit.
const MAX_CHARS = 2000;

/**
 * Sanitize text before embedding:
 * 1. Collapse repeated punctuation (TOC dots "......." → ".") which causes
 *    tokenizer explosion in nomic-embed-text.
 * 2. Hard-cap by character count — CJK text tokenizes at 3-4× the char count,
 *    so we must cap chars, not words, to stay under the 2048 token limit.
 */
function sanitizeForEmbed(text: string): string {
  const cleaned = text
    // Collapse 3+ repeated punctuation → single char
    .replace(/([.\-_=*~。·…])\1{2,}/g, "$1")
    // Collapse whitespace runs
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  // Hard character cap — safe for both CJK and Latin text
  return cleaned.length > MAX_CHARS ? cleaned.slice(0, MAX_CHARS) : cleaned;
}

/**
 * Embed a single text string using Ollama.
 * Returns a 768-dimensional number array.
 * Throws on network / model error — callers should catch and handle.
 */
export async function embedText(text: string): Promise<number[]> {
  const clean = sanitizeForEmbed(text);
  const response = await fetch(`${OLLAMA_BASE_URL}/api/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, prompt: clean }),
  });

  if (!response.ok) {
    throw new Error(
      `Ollama embedding failed: ${response.status} ${response.statusText}`
    );
  }

  const data = (await response.json()) as { embedding: number[] };
  // Truncate to STORE_DIM — pgvector ivfflat cannot index vectors > 2000 dims
  return data.embedding.slice(0, STORE_DIM);
}

/**
 * Embed multiple texts in sequence (Ollama does not batch natively).
 * Returns an array of embeddings in the same order as the input.
 */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  const results: number[][] = [];
  for (const text of texts) {
    results.push(await embedText(text));
  }
  return results;
}
