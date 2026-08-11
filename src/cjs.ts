import { createRequire } from "module";

/**
 * CJS require that works in both runtime modes:
 *  - ESM/tsx dev: import.meta.url is a real file URL.
 *  - esbuild CJS bundle: import.meta.url is replaced with undefined, so we
 *    fall back to __filename (present in CJS) and finally process.cwd().
 *
 * pdf-parse 1.1.1 must be loaded via require (not ESM import): its index.js
 * checks `!module.parent` to detect "debug mode" and otherwise tries to read
 * test/data/05-versions-space.pdf at import time.
 */
export const requireCjs = createRequire(
  import.meta.url ||
  (typeof __filename !== "undefined" ? __filename : process.cwd() + "/server.ts")
);
