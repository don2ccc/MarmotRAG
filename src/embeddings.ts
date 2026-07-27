/**
 * Local embedding via Ollama nomic-embed-text:latest.
 * Ollama must be running and the model must be pulled:
 *   ollama pull nomic-embed-text
 *
 * Output dimension: 768
 */

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
const EMBED_MODEL = "nomic-embed-text:latest";

/**
 * Embed a single text string using Ollama.
 * Returns a 768-dimensional number array.
 * Throws on network / model error — callers should catch and handle.
 */
export async function embedText(text: string): Promise<number[]> {
  const response = await fetch(`${OLLAMA_BASE_URL}/api/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, prompt: text }),
  });

  if (!response.ok) {
    throw new Error(
      `Ollama embedding failed: ${response.status} ${response.statusText}`
    );
  }

  const data = (await response.json()) as { embedding: number[] };
  return data.embedding;
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
