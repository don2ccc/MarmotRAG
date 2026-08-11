# MarmotRAG 检索服务重构 — 实施计划

> **For agentic workers:** 本计划按任务顺序执行，每任务以可验证产物结束。当前以 inline execution 执行。

**Goal:** 把 MarmotRAG 重构为多用户、可分享、纯检索的 RAG 知识服务（无生成、无 pipeline），并模块化拆分后端与前端。

**Architecture:** 保留单 Express 服务；`server.ts` 瘦身为启动器，路由/认证/检索拆到 `src/` 模块；`App.tsx` 拆壳 + tab 组件；演示身份用 `X-User-Id`，Agent 用 `X-API-Key`；可见性 = 本人私有 ∪ 全平台共享。

**Tech Stack:** Node/TypeScript/Express/pgvector/Ollama/React/Vite/Tailwind。

## 任务清单

1. **T1 类型层**：重写 `src/types.ts`（删 Pipeline/PipelineStats；SourceDoc 加 ownerId/isShared；QueryLog 简化；AgentApiKey 去 pipelineId 加 ownerId；StrategyConfig 精简）。
2. **T2 数据层**：重写 `src/db.ts`（幂等迁移；sources/agent_keys/query_logs 新字段；删 pipelines 表；searchChunks 带可见性 JOIN）。
3. **T3 新增模块**：`src/store.ts`（内存状态单例）、`src/auth.ts`（resolveUser + agentAuth）、`src/retrieval.ts`（chunkText + retrieveCore）。
4. **T4 路由**：`src/routes/sources.ts`、`src/routes/agent.ts`（对外仅 `/agent/retrieve`）、`src/routes/system.ts`。
5. **T5 后端瘦身**：重写 `server.ts`（挂载路由；删生成/pipeline/providers/SSO/openapi 旧内容；种子与新形状对齐；启动流程）。
6. **T6 前端基础**：`src/api.ts`（X-User-Id fetch 封装）、`src/components/UserSwitcher.tsx`、`src/tabs/*.tsx` 拆分。
7. **T7 前端功能**：App.tsx 删生成/pipeline/provider/SSO UI；知识库共享开关；检索实验室；API Access 只留 retrieve；Dashboard 简化。
8. **T8 验证**：`tsc --noEmit`、`npm run build`、`scripts/test-retrieval.mjs`、README/`.env.example` 更新。

## 关键签名（跨任务契约）

```ts
// src/retrieval.ts
retrieveCore(opts: { query: string; userId: string; topK?: number; minScore?: number;
  sourceFilter?: string[]; extraSourceFilter?: string[] }): Promise<RetrieveResult>
// RetrieveResult = { query; chunks: RetrievedChunk[]; context: string; latencyMs: number }

// src/db.ts
searchChunks(queryEmbedding: number[], topK: number, opts: {
  userId: string; sourceFilter?: string[]; excludeSourceIds?: string[]
}): Promise<{ id; sourceId; sourceName; text; tokensCount; score }[]>

// src/auth.ts
createResolveUser(getUsers: () => PersistedUser[]): express.RequestHandler
createAgentAuth(getKeys: () => AgentApiKey[], persistKey: (k: AgentApiKey) => Promise<void>): express.RequestHandler
```

## 验证方式

- `npm run lint`（tsc --noEmit）
- `npm run build`（vite + esbuild）
- `node scripts/test-retrieval.mjs`（需要服务运行 + Ollama；含越权 403 断言）
- 手工 curl：三种身份的 retrieve / 分享开关 / key 权限
