/**
 * Minimal Ollama-compatible embedding server for local testing.
 *
 * Implements just enough of the protocol used by src/embeddings.ts:
 *   GET  /api/tags         → 200 {"models":[]}
 *   POST /api/embeddings   → 200 {"embedding":[...]}
 *
 * Vectors are deterministic bag-of-characters embeddings, so identical text
 * always produces identical vectors and lexical overlap produces similarity.
 * Useful when no real model is available (CI, sandbox) — not for quality tests.
 *
 *   node scripts/fake-embed-server.mjs [port]
 */
import http from "node:http";

const PORT = Number(process.argv[2] || process.env.FAKE_EMBED_PORT || 11434);
const DIM = Number(process.env.EMBED_STORE_DIM || 2000);

function embed(text) {
  const v = new Float64Array(DIM);
  for (const ch of String(text)) {
    v[ch.codePointAt(0) % DIM] += 1;
  }
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  return Array.from(v, x => x / norm);
}

const server = http.createServer((req, res) => {
  if (req.url === "/api/tags") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ models: [{ name: "fake-embedding" }] }));
    return;
  }
  if (req.url === "/api/embeddings" && req.method === "POST") {
    let body = "";
    req.on("data", c => { body += c; });
    req.on("end", () => {
      let prompt = "";
      try { prompt = JSON.parse(body).prompt ?? ""; } catch { /* ignore */ }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ embedding: embed(prompt) }));
    });
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end('{"error":"not found"}');
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[fake-embed] listening on http://127.0.0.1:${PORT} (dim=${DIM})`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
