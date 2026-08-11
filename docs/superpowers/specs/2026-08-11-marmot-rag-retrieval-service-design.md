# MarmotRAG 检索服务重构 — 设计文档

**日期**: 2026-08-11
**状态**: 已确认（用户切换器 + 私有/共享 + 纯检索）
**范围**: POC，代码就绪即可；不引入真实登录

## 1. 背景与目标

MarmotRAG 目前是一个带"生成答案"的完整 RAG 平台（Gemini/Ollama 生成、pipeline、faithfulness/relevance 评分），且所有数据全局共享、无身份概念。

核心产品定位已确认为：

1. **用户上传并管理自己的资料**（多用户数据隔离）
2. **每篇文档可选择是否分享**（私有 / 共享 = 平台全可见）
3. **系统作为检索服务对外**：其他 app 通过 API Key 调用，问一个问题，拿回相关度高的 chunk，**不生成答案**

目标形态：一个多用户、可分享、**纯检索**的 RAG 知识服务。

## 2. 非目标（Non-Goals）

- 不做答案生成：删除 Gemini/Ollama 生成、`/api/query`、`/api/agent/query`、评分
- 不做真实登录/SSO：演示模式用 `X-User-Id` 请求头切换用户，保留未来接 session/JWT 的缝
- 不做细粒度分享（指定用户/分组）：只做 `is_shared` 布尔
- 不做混合检索（向量 + BM25）、重排序、检索分页
- 不做多租户数据库：单库 + 行级权限

## 3. 总体架构

单 Node/Express 服务保持不变，做"减法 + 权限 + 模块化"：

```
server.ts                # 瘦身：express 启动、中间件、挂载路由
src/auth.ts              # 演示用户解析 resolveUser + Agent Key 认证 agentAuth
src/retrieval.ts         # chunkText + 检索核心 retrieveCore
src/db.ts                # 表结构 + 持久化（扩展字段、幂等迁移）
src/embeddings.ts        # 不变（Ollama qwen3-embedding:4b）
src/routes/sources.ts    # 文档 CRUD + 分享开关 + parse-pdf + 内部 /api/retrieve
src/routes/agent.ts      # API key 管理 + /api/agent/retrieve + /api/agent/sources
src/routes/system.ts     # health / config / stats / logs / users
src/types.ts             # 精简类型（删 Pipeline 等）
```

前端 `App.tsx` 拆为壳 + 各 tab 组件（见 §9）。

## 4. 数据模型与迁移

`initDb()` 内置幂等迁移（`ADD COLUMN IF NOT EXISTS`），启动时自动执行：

```sql
-- marmot_sources：归属 + 分享
ALTER TABLE marmot_sources ADD COLUMN IF NOT EXISTS owner_id  TEXT NOT NULL DEFAULT '';
ALTER TABLE marmot_sources ADD COLUMN IF NOT EXISTS is_shared BOOLEAN NOT NULL DEFAULT FALSE;
UPDATE marmot_sources SET owner_id = 'u-1' WHERE owner_id = '';

-- marmot_agent_keys：归属用户；去掉 pipeline 绑定
ALTER TABLE marmot_agent_keys ADD COLUMN IF NOT EXISTS owner_id TEXT NOT NULL DEFAULT '';
UPDATE marmot_agent_keys SET owner_id = 'u-1' WHERE owner_id = '';
ALTER TABLE marmot_agent_keys DROP COLUMN IF EXISTS pipeline_id;

-- marmot_query_logs：简化（只记检索，不记答案/评分）
ALTER TABLE marmot_query_logs ADD COLUMN IF NOT EXISTS user_id TEXT NOT NULL DEFAULT '';
ALTER TABLE marmot_query_logs ADD COLUMN IF NOT EXISTS via     TEXT NOT NULL DEFAULT 'user';
ALTER TABLE marmot_query_logs DROP COLUMN IF EXISTS pipeline;
ALTER TABLE marmot_query_logs DROP COLUMN IF EXISTS answer;
ALTER TABLE marmot_query_logs DROP COLUMN IF EXISTS faithfulness_score;
ALTER TABLE marmot_query_logs DROP COLUMN IF EXISTS relevance_score;

-- 删除 pipeline 概念
DROP TABLE IF EXISTS marmot_pipelines;
```

`marmot_chunks` 不改结构；权限过滤在检索时 JOIN `marmot_sources`（单一事实源）。

**种子数据调整**：
- `SEED_PIPELINES`、`computePipelineStats`、`DEFAULT_SYSTEM_PROMPT`、`generateWithOllama`、Gemini 客户端全部删除
- `SEED_USERS` 保留（u-1 Jane Doe / u-2 Marcus Kane / u-3 Sarah Lim）
- `SEED_AGENT_KEYS` 改为带 `owner_id: 'u-1'`、去掉 `pipelineId`
- `SEED_QUERY_LOGS` 改为新 `QueryLog` 形状（query/userId/via/latencyMs/retrievedChunks）

**存量数据现状**（实施时已知）：现有 2 个 source 均为 Paused 且 chunk 表为空（历史维度迁移所致）；迁移后归属 u-1。验证阶段新建一个小文档实测，不依赖旧数据；如需要，可对 YAGEO 文档触发一次 reindex。

## 5. 身份与权限（演示模式）

### resolveUser 中间件（`src/auth.ts`）

- 读取 `X-User-Id` 请求头 → 在内存用户列表中查找
- 缺省 / 无效 → 回退第一个用户（u-1）
- 所有 dashboard 路由挂载；后续换 session/JWT 只替换这一个中间件

### agentAuth 中间件（保留并调整）

- `X-API-Key` → 查找 key → 校验 enabled → 滑动窗口限流 → 更新用量计数
- 挂到 `req.agentKey`，并由此解析 **key 归属用户**

### 可见性规则（全系统统一）

```
可见文档 = (source.owner_id = 当前用户) OR (source.is_shared = TRUE)
```

- 修改/删除/reindex/分享开关：仅 owner，非 owner 返回 403
- Agent key 只继承 key 归属用户的可见范围，再叠加 `sourceFilter`

### 删除 ADMIN_SECRET

key 管理改为"当前用户管理自己的 key"，不再需要全局 ADMIN_SECRET 门禁。

## 6. 检索核心（`src/retrieval.ts`）

```ts
export interface RetrievedChunk {
  chunkId: string; sourceId: string; sourceName: string;
  text: string; score: number; tokenCount: number;
}
export interface RetrieveResult {
  query: string; chunks: RetrievedChunk[]; context: string; latencyMs: number;
}
export interface RetrieveOptions {
  query: string;
  userId: string;                // 可见性判定
  topK?: number;                 // 默认 5，clamp 1..50
  minScore?: number;             // 默认 0，clamp 0..1
  sourceFilter?: string[];       // 文档白名单（可选）
  extraSourceFilter?: string[];  // Agent key 级白名单（内部叠加）
}
export async function retrieveCore(opts: RetrieveOptions): Promise<RetrieveResult>;
```

流程：`embedText(query)` → `searchChunks`（带可见性谓词）→ 叠加过滤器 → `minScore` 过滤 → 取 topK → 组装 `context`。

`src/db.ts` 的 `searchChunks` 重构为：

```ts
export async function searchChunks(
  queryEmbedding: number[],
  topK: number,
  opts: { userId: string; sourceFilter?: string[]; excludeSourceIds?: string[] }
): Promise<{ id; sourceId; sourceName; text; tokensCount; score }[]>
```

SQL 核心：

```sql
SELECT c.id, c.source_id, c.source_name, c.text, c.tokens_count,
       1 - (c.embedding <=> $1) AS score
FROM marmot_chunks c
JOIN marmot_sources s ON s.id = c.source_id
WHERE c.embedding IS NOT NULL
  AND s.status = 'Synced'
  AND (s.owner_id = $2 OR s.is_shared = TRUE)
  [AND c.source_id = ANY($n::text[])]      -- sourceFilter
  [AND c.source_id <> ALL($m::text[])]     -- excludeSourceIds
ORDER BY c.embedding <=> $1
LIMIT $k
```

## 7. API 契约

### Agent API（对外，`X-API-Key`）

**POST `/api/agent/retrieve`**（核心）

```jsonc
// 请求
{ "query": "2024年国巨集团的毛利率是多少？", "topK": 5, "minScore": 0.3, "sourceFilter": ["src-..."] }
// 响应
{
  "query": "...",
  "chunks": [
    { "chunkId": "src-...-chk-0", "sourceId": "src-...", "sourceName": "YAGEO_ESG2024_tw",
      "text": "...", "score": 0.82, "tokenCount": 128 }
  ],
  "context": "[Document 1: YAGEO_ESG2024_tw]\ntext...",
  "latencyMs": 245
}
```

过滤器叠加顺序：`可见性 ∩ key.sourceFilter ∩ 请求 sourceFilter`。

**GET `/api/agent/sources`**：key 归属用户可见文档 ∩ key.sourceFilter，字段 `{ id, name, type, vectorsCount, lastSync, isShared, ownerName }`。

**Key 管理**（当前用户，无 ADMIN_SECRET）：
- `GET /api/agent/keys` / `POST /api/agent/keys` / `PATCH /api/agent/keys/:id` / `DELETE /api/agent/keys/:id`
- 创建/修改时 `sourceFilter` 只允许选择该用户可见的文档 id
- 返回字段去掉 `pipelineId`

**删除**：`/api/agent/query`、`/api/query`、`/api/pipelines*`。

### Dashboard API（`X-User-Id`）

- `GET /api/sources`：当前用户的文档 + 共享文档（含 `ownerId/ownerName/isShared`）
- `POST /api/sources`：owner = 当前用户
- `PATCH /api/sources/:id`：owner 可改 `name/type/status/isShared`；非 owner 403
- `DELETE /api/sources/:id`、`POST /api/sources/:id/reindex`、`GET /api/sources/:id/chunks`：owner 限定（chunks 预览对可见文档开放）
- `POST /api/retrieve`：内部检索（Playground 用），同 `retrieveCore`
- `GET /api/health`：去掉 `geminiActive`
- `GET/POST /api/config`：`StrategyConfig` 只保留分片/pg/Ollama 配置（去掉 `ssoEnabled`、`providerList`、`externalVectorDb`）
- `GET /api/stats`：`{ totalVectors, ownSources, sharedSources, syncedSourceCount, queryCount, avgLatencyMs }`
- `GET /api/logs`（含 export）：仅当前用户自己的日志（agent 日志归属 key 的 owner），去掉评分字段
- `GET/POST/DELETE /api/users`：保留（演示用户管理）
- 删除 `/api/providers`、`/api/test-connectivity`

## 8. 前端改动

```
src/App.tsx                   # 壳：currentUser 状态、UserSwitcher、tab 导航
src/api.ts                    # fetch 封装，自动带 X-User-Id
src/components/UserSwitcher.tsx
src/tabs/DashboardTab.tsx
src/tabs/WorkspaceTab.tsx
src/tabs/KnowledgeBaseTab.tsx
src/tabs/AdminTab.tsx
src/tabs/PlaygroundTab.tsx    # 检索实验室
src/tabs/ApiAccessTab.tsx
```

- **Header**：用户切换器（下拉，默认 u-1），所有请求带 `X-User-Id`
- **知识库**：自己的文档显示"共享"开关；他人共享文档带 `共享 · by XXX` 徽标且只读（无 reindex/删除/改名）
- **检索实验室**（原 Playground）：query 输入 → 展示 chunks（source、score、可展开文本）+ 延迟；删除答案/指标卡/pipeline 选择
- **API Access**：key CRUD（label / 限流 / sourceFilter 可选），文档面板只留 retrieve；用量卡片按当前用户
- **Dashboard**：简化指标（查询数/延迟/存储），日志表去掉评分，保留可展开的 retrievedChunks
- **Workspace**：只留分片配置（chunkSize/overlap/strategy）+ pgvector/Ollama 展示；删除 provider/SSO/外部向量库相关内容
- **Admin**：只留用户列表；删除 provider 卡片、SSO stub
- 删除 `SafeRAGResponseRenderer`（不再有答案文本）

## 9. 验证与测试

`scripts/test-retrieval.mjs`（替换 `test-pipelines.mjs`），需要服务运行 + Ollama：

1. health 检查
2. 用户 A 建一个小文档 → embedding → 检索命中
3. 分享开关：共享后用户 B 可见且可检索；关闭后 B 不可见
4. 越权：B 修改/删除 A 的文档 → 403
5. 用户 A 创建 key → `X-API-Key` retrieve 命中；key 的 sourceFilter 生效
6. 用户 B 的 key 检索 A 的私有文档 → 无结果
7. 删除文档 / 吊销 key 后对应资源不可用

手工 curl 示例写入 README（Agent API 章节重写为纯检索）。

## 10. 未来扩展缝

- `resolveUser` 换成 session/JWT 中间件即得真实登录
- `is_shared` 布尔升级为 `shared_with` 列表（分享到指定用户）
- `searchChunks` 加 BM25 混合检索或重排序
- PDF 分页元数据（page 字段）随 chunk 存储

## 11. 已确认决策记录

| 问题 | 决策 |
|---|---|
| 认证方式 | B：演示模式 `X-User-Id` 切换器，留认证缝 |
| 分享粒度 | A：`is_shared` 布尔，共享 = 平台全可见 |
| 是否生成答案 | 否，纯检索，生成相关全部删除 |
| 实现路径 | B：减法 + 权限 + 模块化（server.ts 拆分、App.tsx 拆 tabs） |
