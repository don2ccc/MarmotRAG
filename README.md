# Marmot RAG: Enterprise Full-Stack RAG Engine & Playground

Marmot RAG is a highly visual, production-grade enterprise Retrieval-Augmented Generation (RAG) management dashboard and query-evaluation playground. It implements real-time document chunking, client-server data synchronization, cosine vector similarity comparisons, and context-grounded AI generation using the official `@google/genai` TypeScript SDK.

---

## 🚀 Key Features

* **Real-Time Text Chunking & Embedding**: Supports three configurable chunking strategies:
  * **Fixed-size**: Character/word-based sliding window.
  * **Semantic**: Sentence boundary-based segmentation.
  * **Recursive**: Multi-level hierarchical paragraph partitioning.
* **True Vector Similarity Search**: Implements local vector database matching via server-side Cosine Similarity scoring, pulling the top 3 corresponding document nodes.
* **Grounded Generation & AI Reasoning**: Utilizes the advanced `gemini-3.5-flash` model for synthesis. It constraints the model's response to retrieved context chunks using strict system instructions and schema boundaries, outputting metadata-rich evaluation scores (faithfulness rating and relevance score).
* **Interactive Document Corpus & Image Support**: Supports HTML content, rendering inline visual elements (e.g., topology maps and architecture blueprints) within the grounding chain.
* **Dynamic Dual-Theming**: Native toggle system allowing developers and users to switch seamlessly between a pristine, high-contrast **Light Slate Theme** (the default mode with Indigo accenting) and a futuristic **Midnight Neon-Green Dark Theme**.

---

## 📁 Repository Structure

```bash
├── package.json         # Build configuration, npm dependencies, and script declarations
├── server.ts            # Custom Express backend, lazy Gemini init, chunking pipeline, and search endpoints
├── vite.config.ts       # Vite-specific bundler settings integrated with Tailwind CSS
├── index.html           # SPA entry point
├── metadata.json        # Application metadata used by the hosting container
├── src/
│   ├── main.tsx         # React app bootstrap file
│   ├── App.tsx          # Core React SPA containing all view state and responsive layouts
│   ├── index.css        # Tailwind style directives and dedicated Light/Dark theme overrides
│   └── types.ts         # Centralized TypeScript definitions and types
└── .env.example         # Template for environment configuration and secrets
```

---

## 🛠️ Architectural Details

### 1. Backend: In-Memory Database & Core Pipeline (`server.ts`)
The server acts as a self-contained RAG simulation environment and secure API proxy. Key mechanisms include:
* **Lazy Initialization**: To prevent application crashes when deployment variables are missing, the Gemini AI client (`GoogleGenAI`) is instantiated lazy-loaded via the `getAI()` guard. If a `GEMINI_API_KEY` is not present, the system gracefully degrades to a local offline fallback using trigonometric hash embedding indices.
* **Real Vector Search**: Ingested sources are split on the fly. Each text chunk gets real-time embeddings computed with `gemini-embedding-2-preview` (or mock vectors when offline). Query submissions then perform direct cosine calculations in server memory.
* **Structured System Grounding**: Uses the model system instruction to force strict JSON generation containing the final grounded answer and synthetic scoring logs:
  ```json
  {
    "answer": "Grounded response citing [Sources]...",
    "faithfulnessScore": 98,
    "relevanceScore": 92
  }
  ```

### 2. Frontend: Modular Views & State (`src/App.tsx`)
The React user interface organizes capabilities into 5 tabs (`TabType`):
1. **Dashboard** (`"dashboard"`): Visualizes continuous uptime, mean execution latencies, and storage quotas. Lists detailed query logs and similarity-ranked document chunks.
2. **Strategy Config** (`"workspace"`): Modulates paragraph separation limits, sliding chunk parameters, and manages active model API configurations.
3. **Knowledge Base** (`"knowledge-base"`): Ingests external documents (text inputs or file uploads) with instant preview telemetry of generated vectors.
4. **Admin Control** (`"admin"`): Oversees tenant configurations, lists connected engineers, and regulates user access roles.
5. **RAG Playground** (`"playground"`): Features live diagnostic trace chains, rendering the input query side-by-side with matched nodes and final structured prompt outputs.

### 3. Theme Toggle Mechanics (`src/index.css`)
Theme switching is controlled via a simple react state hook (`themeMode`) toggled between `"light"` and `"dark"`. It injects a `.theme-light` or `.theme-dark` class onto `document.body`.
* All light style overrides are encapsulated cleanly under `.theme-light` inside `/src/index.css` by overriding Tailwind colors.
* Key variables, borders, cards (`.soft-card`), inputs, selection dropdowns, and text opacity are mapped smoothly to ensure responsive design compliance without code clutter.

---

## 💻 Local Development Setup

Follow these simple steps to run Marmot RAG on your local machine:

### 1. Prerequisites
Ensure you have **Node.js** (v18 or higher) and **npm** (or bun/yarn) installed.

### 2. Install Dependencies
Clone this repository and run the setup script:
```bash
npm install
```

### 3. Configure Secrets
Create a `.env` file in the root directory and define your API keys:
```env
GEMINI_API_KEY=your_actual_gemini_api_key_here
NODE_ENV=development
```

### 4. Boot Dev Server
Launch the full-stack development environment:
```bash
npm run dev
```
The application will boot up at `http://localhost:3000`. This uses Vite's developer middleware integrated directly inside the Express server for live compilation.

### 5. Build for Production
To bundle the frontend assets and compile the TypeScript Express backend into a single distribution module:
```bash
npm run build
```
The compiled server gets written to `dist/server.cjs` via `esbuild`, and static assets are generated in `dist/`.

To launch the compiled production system:
```bash
npm run start
```

---

## 🤖 Guide for Future AI Coding Agents & Developers

When you are requested to extend or modify Marmot RAG, please adhere to these strict coding protocols:

### A. Maintain Lazy Initialization Guard
Never attempt to instantiate the `GoogleGenAI` client directly in global scope. Always route model actions through the `getAI()` function to prevent server boot failures if environment files are not fully populated.
```typescript
// ✅ Good Pattern (server.ts)
const ai = getAI();
if (ai) {
  // execute API operations safely
}
```

### B. Type Definition Consistency
All shared interfaces must be updated in `/src/types.ts` first, and then correctly aligned with the backend model schemas inside `/server.ts`. Ensure standard `enum` types are used rather than `const enum` if any additional enumerations are introduced.

### C. Styling and Theme Preservation
* Prefer using utility Tailwind classes directly inside the JSX.
* When adding custom cards or visual modules, apply the `.soft-card` utility class to keep design rhythm uniform.
* If a new layout component requires unique color mapping, add the corresponding light-theme selector rules inside the `/* Light Theme Overrides */` block in `/src/index.css` under the `.theme-light` selector class hierarchy.

### D. Keep Full-Stack Ingress Bound
Do not override the configuration port. Port `3000` is the single externally routed entry point configured on host `0.0.0.0`. Keep `app.listen(PORT, "0.0.0.0")` intact inside `server.ts`.
