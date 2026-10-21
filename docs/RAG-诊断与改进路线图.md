# MarmotRAG 现状诊断与改进路线图

> 分析对象：当前仓库代码（`server.ts` + `src/**`）。
> 定位：只做 R（Retrieval）中的 chunk / embed / store / query，G（Generation）交给外部 Agent。
> 结论先行：**当前实现是一个"能跑通的向量检索 MVP"，还不是"可长期运营的知识服务"。**
> 主要风险不在检索算法，而在三处：**更新会让知识静默消失**、**没有版本概念导致无法回答"哪一版"**、**对外契约太薄导致 Agent 无法正确使用检索结果**。

---

## 0. 一句话结论

| 维度 | 现状 | 判断 |
|---|---|---|
| 检索通道 | 纯向量（HNSW + cosine），无词法通道 | 对型号/料号/术语类查询召回不可靠 |
| 知识更新 | 全量删除后重建；Agent 写入 create-only | **更新期间知识真空，失败后知识消失** |
| 版本管理 | 无版本概念，`last_sync` 是 `"14:22:18"` 这种字符串 | 无法回答"哪一版"、无法回滚、无法 as-of |
| 策略粒度 | 全局单例 chunk 配置，改配置不触发重建 | 库内会混合多种切分策略且无法识别 |
| 对外契约 | 返回 `text + score + sourceName` | Agent 拿不到引用、充足性信号、反馈入口 |
| 工程基线 | 同步逐条嵌入、内存全量状态、日志 O(n) 剪枝 | 规模上去后延迟与内存先崩 |

---

## 1. 系统现状（按代码事实）

### 1.1 数据模型

三张业务表 + 三张辅助表（[db.ts](../src/db.ts)）：

```
marmot_chunks   (id PK, source_id, source_name, text, tokens_count, embedding vector(2000))
marmot_sources  (id PK, name, type, status, last_sync TEXT, vectors_count, owner_id, is_shared, content)
marmot_config   (key, value)                     -- 全局单例 JSON
marmot_agent_keys / marmot_query_logs / marmot_users
```

值得注意的几点：

- `marmot_chunks` 只有 `id / source_id / source_name / text / tokens_count / embedding`，**没有任何来源定位信息**（页码、章节、字符区间、版本、模型）。见 [db.ts:69-77](../src/db.ts#L69)。
- `marmot_sources.content` 保存**全文原文**，既用于重索引，也在启动时被整表读进内存（[db.ts:273](../src/db.ts#L273)、[server.ts:244](../server.ts#L244)）。
- 索引是 HNSW、`vector_cosine_ops`、`m=16, ef_construction=64`，**没有设置 `ef_search`，也没启用 `iterative_scan`**（[db.ts:78-83](../src/db.ts#L78)）。
- `marmot_chunks` 上**没有 `source_id` 的 B-tree 索引**，但检索必然带 `source_id` 过滤。

### 1.2 写入面（三条路径，语义各不相同）

| 路径 | 入口 | 行为 |
|---|---|---|
| 控制台新建 | `POST /api/sources`（SSE） | 切分 → 逐条嵌入 → 逐条 upsert，边写边推进度（[sources.ts:148-210](../src/routes/sources.ts#L148)） |
| 控制台重索引 | `POST /api/sources/:id/reindex` | 先把状态置 `Syncing...`、**删除该源全部 chunk**，再重新嵌入（[sources.ts:213-266](../src/routes/sources.ts#L213)） |
| Agent 写入 | `POST /api/agent/sources` | **create-only**：id 已存在直接 409，Agent 永远不能更新知识（[agent.ts:168-181](../src/routes/agent.ts#L168)、[ingest.ts:26-32](../src/ingest.ts#L26)） |

三条路径都走同一个 `chunkText()`，但 chunks 的 id 是**位置式**的 `` `${docId}-chk-${i}` ``。这意味着：**内容一改，同一位置上的 chunk 身份就被复用，但语义已经不同**。

### 1.3 读取面

`retrieveCore()`（[retrieval.ts:106-143](../src/retrieval.ts#L106)）→ `searchChunks()`（[db.ts:211-255](../src/db.ts#L211)）：

```sql
WHERE c.embedding IS NOT NULL
  AND s.status = 'Synced'
  AND (s.owner_id = $2 OR s.is_shared = TRUE)
ORDER BY c.embedding <=> $1
LIMIT $k
```

- 可见性 = 本人 + 平台共享，**只有这一层**（没有组织/集合/密级/部门）。
- `status = 'Synced'` 是硬门槛：**任何非 Synced 状态的知识对检索完全不可见**。
- 一次取 `topK * 2`，再在应用层用 `minScore` 过滤并截断到 `topK`（[retrieval.ts:120-124](../src/retrieval.ts#L120)）。
- 返回 `context` 是简单拼接：`[Document i: name]\n text`，**没有稳定引用编号、没有页码、没有 token 预算**（[retrieval.ts:134-136](../src/retrieval.ts#L134)）。

### 1.4 对外契约与配置

- 公开 API 只有两个：`POST /api/agent/retrieve`、`POST /api/agent/sources`（[server.ts:330-389](../server.ts#L330)）。
- 参数是裸的 `topK / minScore / sourceFilter` —— **把调参责任推给了 LLM**。
- chunk 策略是**全局单例**：`chunkSize / chunkOverlap / separationStrategy`（[server.ts:188-200](../server.ts#L188)），保存配置**不会触发任何重建**（[system.ts:48-58](../src/routes/system.ts#L48)）。
- 嵌入模型由 env 决定，**chunk 上不记录模型名/维度**。

---

## 2. 问题清单

下面按"会影响什么"分层，每条给「现象 → 证据 → 影响 → 建议」。P0/P1/P2 的含义见第 3 节。

### A. 检索质量

#### A1. 只有向量通道，没有词法通道 —— 精确 token 召回系统性偏低【P0/P1】

**现象**：`searchChunks` 只有 `embedding <=> query`，全库没有任何倒排索引、没有 `tsvector`、没有 `pg_trgm`。「用户提供关键字」实际上只是把关键字当成一句自然语言去算语义相似度。

**影响**：低频精确 token 是 embedding 的天然弱项——料号（`CC0603KRX7R9BB104`）、封装（`0402`、`0603`）、标准号（`AEC-Q200`、`RoHS`、`IATF 16949`）、错误码、人名、内部项目代号。这类查询的 top-k 经常被"语义接近但字面无关"的段落占满。**如果语料是元器件规格书/料号库，这是第一优先级问题，比换更大模型收益高一个量级。**

**建议**：双通道 + 融合。
- 词法通道：`pg_trgm` GIN（对料号最有效）+ 中文 FTS（`PGroonga` 或 `zhparser`）；
- 融合用 RRF（倒数排名融合），不要试图把 cosine 和 BM25 归一化后加权——两者分数量纲不可比；
- 料号单独做归一化列（去空格/统一大小写/拆前缀），进独立 trigram 索引。

#### A2. `minScore` 语义不可移植，且会被 `topK*2` 掩盖【P0】

**现象**：`score = 1 - cosine_distance`，被 clamp 在 0..1，UI 用 0.7/0.4 分档显示为绿/黄/红（[PlaygroundTab.tsx:119-124](../src/tabs/PlaygroundTab.tsx#L119)）。

**影响**：这个分数**没有跨 query 的可比性**——同一阈值，宽泛 query 可能全部 0.8，窄 query 可能最高只有 0.45。用户/Agent 无法据此判断"够不够好"。而 `topK*2` 预取再过滤，会让"返回数 < topK"这件事看起来像"知识不够"，实际可能是过滤太狠。

**建议**：
- 保留 `score` 作为**排序**依据，另给 `status: hit|weak|empty` 作为**决策**依据（用 bestScore 与本 query 内部分布的相对 gap 判定，而不是硬阈值）；
- 文档里明确 `minScore` 是"相对截断"，不是"质量保证"；
- 长期用 rerank 分（cross-encoder）替代 cosine 作为主分数。

#### A3. 过滤 + HNSW = 后过滤，返回可能不足 k【P0】

**现象**：`ORDER BY <=> LIMIT k` 叠加 `source_id = ANY(...)` / `status='Synced'` / 权限条件。pgvector 在启用 `iterative_scan` 之前是"先取候选再过滤"，过滤选择性高时返回行数会显著少于 k。

**影响**：越是用 `sourceFilter` 收窄（Agent 场景很常见），越容易"明明有知识却只返回 1-2 条"。

**建议**（pgvector 0.8 已支持）：
```sql
SET LOCAL hnsw.ef_search = 100;
SET LOCAL hnsw.iterative_scan = relaxed_order;   -- 关键
SET LOCAL hnsw.max_scan_tuples = 20000;
```
配合给 `source_id` 建 B-tree 索引；数据量再大时按 `source_id` 做分区/部分索引。

#### A4. 嵌入输入与存储文本不一致（静默截断）【P0】

**现象**：三处独立截断同时存在：
- `MAX_CHARS = 2000`，`sanitizeForEmbed` 直接 `slice(0, 2000)`（[embeddings.ts:84-102](../src/embeddings.ts#L84)）；
- UI 允许 `chunkSize` 最大 2048（[WorkspaceTab.tsx:93](../src/tabs/WorkspaceTab.tsx#L93)）；
- 向量再截到 2000 维（[embeddings.ts:79](../src/embeddings.ts#L79)、[embeddings.ts:159](../src/embeddings.ts#L159)）。

**影响**：**chunk 超过 2000 字符时，向量只代表前半段，但 `text` 字段返回全文。** 检索命中靠前半段，召回的内容却包含后半段——评估时会表现为"召回了但答不上"。同理，10000 字符的 query 也被静默截到 2000 字符。

**建议**：把「chunk 最大长度」和「嵌入最大长度」统一成一个物理约束，超长块必须**拆**而不是**截**；在 chunk 上记录 `embed_input_chars`，让"向量覆盖范围 ≠ 文本范围"这件事不可能隐式发生。

#### A5. 两套 token 计数，数字不可信【P0】

**现象**：切分用 jieba 分词计数（[retrieval.ts:37-39](../src/retrieval.ts#L37)），写入时 `tokensCount` 却用 `text.split(/\s+/)`（[ingest.ts:70](../src/ingest.ts#L70)、[sources.ts:139](../src/routes/sources.ts#L139)、[server.ts:235](../server.ts#L235)）。

**影响**：中文块 `split(/\s+/)` 通常返回 1——UI 显示"1 tokens"，token 预算计算、日志统计、按 token 计费全部失真。

**建议**：单一函数 `countTokens()` 全链路复用；`tokens_count` 只由服务端计算，不接受外部写入。

#### A6. 切分策略本身的问题【P1】

- **Semantic 分支会丢尾句**：正则 `/.../ [.!?。！？\n]+/g` 只匹配"带结束标点的句子"，文末没有标点的最后一句**不会被收集**（[retrieval.ts:63](../src/retrieval.ts#L63)）。
- **超长句子不拆**：单句超过 `size` 时仍然整句 push，chunk 可以任意超长（[retrieval.ts:83-84](../src/retrieval.ts#L83)），再叠加 A4 的截断。
- **Fixed 分支破坏拉丁文**：`slice.join("")` 用空串拼接 jieba token，英文单词之间空格消失（[retrieval.ts:59](../src/retrieval.ts#L59)）。
- **`totalTokens < size/2` 时强制走 Fixed**：短文档的"策略选择"是假的（[retrieval.ts:54](../src/retrieval.ts#L54)）。
- **无结构感知**：PDF/DOCX 拍平成纯文本后切分，标题层级、表头、列表结构全部丢失。表格类内容（规格书参数表）会被切碎且丢失"这列是什么"的上下文。
- **overlap 单位错**：UI 标 `%`（[WorkspaceTab.tsx:103](../src/tabs/WorkspaceTab.tsx#L103)，范围 0–50），代码当**token 数**用（[sources.ts:171](../src/routes/sources.ts#L171)）。用户以为设了 20% 重叠，实际是 20 个 token。

**建议**：见 C 节"策略结构化"。

#### A7. 无 rerank、无去冗余【P1】

没有 cross-encoder 重排，没有 MMR/相似度去重。同一文档相邻块经常在 top-5 里占 3 席，实际信息量接近 1 条。

**建议**：先 MMR（便宜，立刻可用），再考虑 bge-reranker 类模型（对精度提升明显，但要算 latency 预算）。

#### A8. 无查询理解层【P2】

无改写、无多查询、无同义词/缩写词典（`MLCC` ↔ `贴片电容`，`R0402` ↔ `0402`）、无 HyDE。对"口语化提问 + 专业语料"的组合，这是召回损失的大头。

---

### B. 知识版本与更新管理（重点）

> 这一层是当前最薄弱的环节，也是"知识库能不能被信任"的分水岭。

#### B1. 没有版本概念【P0】

`marmot_sources` 只有 `last_sync TEXT`，且写入的是 `new Date().toLocaleTimeString()` —— **只有时分秒，没有日期**（[sources.ts:193](../src/routes/sources.ts#L193)、[ingest.ts:80](../src/ingest.ts#L80)）。跨天更新后，`"14:22:18"` 无法排序、无法判断新旧。

**影响**：无法回答"这条信息是什么时候的"、"有没有更新版"、"上一版怎么写的"。

#### B2. chunk 身份是位置式的，不可追溯【P0】

`src-1-chk-3` 在 v1 和 v2 里指向完全不同的内容。引用无法定位到"哪一版的第几段"。

**影响**：Agent 给出引用后，用户点开可能看到别的内容；审计、纠错、回滚全部做不了。

#### B3. 重索引先删后建 → 知识真空 + 失败即失联【P0 ★最严重】

`/reindex` 的顺序是：`status='Syncing...'` → **DELETE 全部 chunk** → 逐条嵌入（[sources.ts:225-245](../src/routes/sources.ts#L225)）。
而检索端要求 `s.status='Synced'`（[db.ts:219](../src/db.ts#L219)）。

于是：
1. **重建期间该源完全不可检索**（状态不是 Synced，chunk 也被删了）；
2. **中途失败 → catch 里把状态写成 `Auth Error`**（[sources.ts:256-263](../src/routes/sources.ts#L256)）→ 该源**永久退出检索**，且只留下部分 chunk（孤儿数据）；
3. **进程崩溃 → 启动时"自愈"逻辑把状态改 `Paused` 并删掉残留 chunk**（[server.ts:256-276](../server.ts#L256)）→ 知识被主动清除，必须人工重索引才能回来。

**影响**：一次失败的更新 = 一次静默的知识下线。这是最该先修的问题——**更新不应该降低可用性**。

#### B4. 换嵌入模型会直接删表【P0】

维度不匹配时执行 `DROP TABLE IF EXISTS marmot_chunks`（[db.ts:62-66](../src/db.ts#L62)）。随后启动检测到 chunk 表为空，把所有源标成 `Paused`（[server.ts:279-292](../server.ts#L279)）。

**影响**：换模型 = 全量向量销毁 + 全库下线，没有备份、没有迁移、没有回填。而注释里还写着"wiping all stored vectors"——说明这是已知行为。

#### B5. Agent 写入 create-only → 知识无法演进【P1】

[agent.ts:176-181](../src/routes/agent.ts#L176)、[ingest.ts:26-32](../src/ingest.ts#L26)：id 冲突直接 409，注释明确写"agents may never overwrite knowledge"。

**影响**：Agent 学到"价格从 10 改成 12"，只能新建一个 id。于是库里同时存在 10 和 12，检索随机召回旧值。**知识只会增长，不会收敛。** 这是"G 外包"架构下最典型的断点：写回没有闭环。

**建议**：把"不可覆盖"改成"**不可静默覆盖**"——允许更新，但要求 `expectedVersion` 乐观锁 + 留版本历史 + 可回滚。

#### B6. 无内容哈希、无去重、无近重复检测【P1】

同一份文档换个名字再入库 → 两份完全重复的 chunk 竞争 top-k。没有 `content_sha256`，无法做幂等，也无法做增量。

#### B7. 无失效/替代/时效语义【P1】

没有 `superseded_by`、`deprecated_at`、`effective_from/to`、TTL。旧规格书、旧价格、已废止制度会和新版**平等参与排序**。

**影响**：这是"知识库越用越不准"的根因之一——不是召回错了，是召回了两代并存的知识。

#### B8. 无 as-of 查询【P2】

无法回答"2024 年 3 月的版本里这条参数是多少"。合规、审计、客诉复盘场景会直接卡住。

#### B9. 无更新审计与回滚【P2】

没有 `doc_versions` 表，没有变更事件流，没有"谁在什么时候把哪段改成了什么"。

---

### C. 精细化策略（重点）

#### C1. 策略是全局单例，无法按源/类型/租户区分【P1】

`store.strategyConfig` 只有一份（[store.ts:8-14](../src/store.ts#L8)）。但现实中：制度文件要段落切、规格书要表格+章节切、FAQ 要一问一答切、代码要语法切。

**建议**：策略作用域四级 —— `global → collection → document → per-request override`，document 级优先。

#### C2. 改配置不重建，库内策略混杂且无法识别【P1】

保存配置只写 `marmot_config`（[system.ts:48-58](../src/routes/system.ts#L48)），**不触发任何重索引**，chunk 上也不记录"我是用哪套参数切的"。

**影响**：库里同时存在 120-token 块和 500-token 块，但没有任何字段能区分。做 A/B 或排查召回问题时无从下手。

**建议**：在 chunk/version 上存 `chunk_strategy_hash`（参数 JSON 的 sha256）。改配置 = 标记 stale，后台渐进重建，而不是静默生效。

#### C3. overlap 单位、chunkSize 上限、token 计数三处不一致【P0】

见 A5、A6。这三处会互相放大：UI 设 2048 token → 中文块可能 2000+ 字符 → 嵌入被截到 2000 字符 → `tokens_count` 又显示 1。

#### C4. 无结构/表格/公式/代码感知切分【P1】

对元器件 datasheet 尤其致命：参数表被拍平后，"Vdc=50V" 和 "封装=0603" 会散落在不同 chunk，且各自丢失表头。

**建议**：
- 解析阶段保留结构（标题路径、表格行列、页码）；
- 表格单独成块，且**每块重复表头**；
- chunk 元数据带 `heading_path` / `page_from` / `table_id`；
- 支持"小-大检索"：小块用于命中，返回时扩展到父段落（small-to-big）。

#### C5. 无 metadata 过滤与召回预算【P2】

只能按源过滤。缺：时间、产品线、文档类型、语言、密级、地区。也缺"按 token 预算取块"（现在只有 topK）。

#### C6. 无 per-request 策略覆盖【P2】

Agent 无法说"这次要句子级、要 800 token 预算、只要 2024 年之后的"。

---

### D. 工程与运维

| # | 问题 | 证据 | 影响 |
|---|---|---|---|
| D1 | 嵌入逐条串行，`embedTexts` 并发函数写好了但**没被使用** | [ingest.ts:62-75](../src/ingest.ts#L62)、[sources.ts:130-143](../src/routes/sources.ts#L130) vs [embeddings.ts:189](../src/embeddings.ts#L189) | 50k 字符 ≈ 40 块 × 单次延迟，同步请求易超时；写入吞吐只有 1/3 |
| D2 | 无任务队列、无断点续传 | 同上 | SSE 断开即中断；重启即丢进度 |
| D3 | 全量 `content` 常驻内存 | [server.ts:244](../server.ts#L244)、[db.ts:273](../db.ts#L273) | 内存随知识库线性增长，50MB 文档 × N 份 |
| D4 | 每次检索都 `COUNT(*)` 全表再删旧日志 | [db.ts:586-597](../src/db.ts#L586) | O(n) 写放大；日志表越大越慢 |
| D5 | 日志存 chunk 全文 | [agent.ts:138](../src/routes/agent.ts#L138) | 体积膨胀 + 文本隐私外泄面 |
| D6 | 每次 Agent 请求都整行 UPDATE key 计数 | [auth.ts:73](../src/auth.ts#L73) | 检索 1 次 = 1 次 DB 写；高频下成为瓶颈 |
| D7 | 限流窗口在进程内存 | [auth.ts:29](../src/auth.ts#L29) | 多实例失效；重启清零 |
| D8 | API key 明文存库、`===` 比较 | [auth.ts:37](../src/auth.ts#L37) | 拖库即泄露；无轮换/无过期 |
| D9 | 身份靠 `X-User-Id` 头 | [auth.ts:17-19](../src/auth.ts#L17) | 任意伪造；当前是 demo 级 |
| D10 | 内存态与 DB 双写，先内存后 DB、失败不回滚 | [store.ts](../src/store.ts)、各路由 | 进程状态与库不一致 |
| D11 | 检索完全依赖嵌入服务，无降级 | [retrieval.ts:111](../src/retrieval.ts#L111) | Ollama 挂 = 检索全挂（有词法通道即可降级） |
| D12 | 日志 `status` 把"0 命中"记成 `"error"` | [agent.ts:137](../src/routes/agent.ts#L137)、[sources.ts:348](../src/routes/sources.ts#L348) | 面板指标失真，空召回率无法统计 |
| D13 | 种子数据嵌入后不回写 `vectors_count` | [server.ts:217-243](../server.ts#L217) | 面板显示 0 向量，但实际有 chunk |
| D14 | `status` 一个字段承载 4 种语义（健康/进度/错误/暂停） | [types.ts:14](../src/types.ts#L14) | `Auth Error` 被当作索引失败；无法表达"已索引但已过期" |

---

### E. 「G 外包给 Agent」带来的特有缺口（最有价值的部分）

把 G 交出去是**对的架构选择**（企业内部 Agent 框架多样，不该被绑定）。但它把 R 的定位变了：

> R 不再是一个"给自家 LLM 取几段文本"的内部函数，而是一个**要被外部 Agent 正确使用的检索服务**。

现在的契约还停留在"函数调用"级别，缺 6 样东西：

#### E1. 没有可核验的引用协议【P0】

返回 `{chunkId, sourceName, text, score}`。Agent 没法给出 `[1]` 这种可点击引用，也没法说"这句话在第 12 页第 3 节第 2 版"。

**建议**：返回 `citations[]`，每条带 `{citationId, chunkId, docId, docVersion, title, headingPath, page, charRange}`，且 `context` 里用 `[c1]` 标注，让 Agent 直接复用编号。

#### E2. 没有反馈回路 → R 的质量无法被度量【P0】

不知道 Agent 用了哪几条、答案是否被用户接受、哪些查询空召回。

**建议**：
- `retrieve` 返回 `retrievalId`；
- 新增 `POST /api/agent/feedback`，上报 `usedCitationIds` + `verdict`；
- 空召回 query 聚类 = 知识缺口清单；`usedCitationIds` = 相关性标注的来源。这两条数据能把"调参"从玄学变成工程。

#### E3. 没有充足性信号 → Agent 无法决定"要不要换个问法"【P1】

现在只返回数组，`[]` 和"知识库里没有"无法区分。Agent 要么直接说"不知道"，要么硬编。

**建议**：`status: hit | weak | empty` + `diagnostics {bestScore, scoreGap, lexicalHits, vectorHits, reranked}`。Agent 看到 `weak` 就该改写查询或缩小范围。

#### E4. 没有 context 预算与去重【P1】

`context` 是无上限拼接，且重复内容不折叠。Agent 的上下文窗口会被低价值块占满。

**建议**：`budgetTokens` 参数 + 按边际信息增益选块 + 相邻块合并。

#### E5. 没有写回闭环【P0，同 B5】

Agent 只能 append，不能 correct。知识库会持续膨胀而精度持续下降。

#### E6. 裸参数暴露给 LLM，但 LLM 不会调参【P2】

`topK / minScore` 对 LLM 是无意义旋钮。

**建议**：换成档位 `mode: fast | balanced | deep`，服务端映射到 `ef_search / 候选数 / 是否 rerank / 预算`。

---

## 3. 路线图

### P0 — 先止血（1–2 周，不改变架构）

目标：**更新不再让知识消失；数字不再骗人；换模型不再删库。**

1. **双缓冲更新**：新 chunk 先写入"影子版本"，成功后在事务里原子切换 `active_version`；失败保留旧版本并记录错误。删除"先删后建"。
2. **失败不降级**：`Auth Error` 不能再等同于"不可检索"。拆字段：`index_state(building|active|failed|stale)` + `last_error`，`failed` 时**继续服务旧版本**。
3. **去掉自动 DROP TABLE**：新增 `embedding_model / embedding_dim` 列，双列并存 + 后台回填 + 原子切换；保留旧表至切换完成。
4. **统一 token 计数**；修 overlap 单位（要么真按 % 换算，要么 UI 改成 token）；`chunkSize` 上限 ≤ 嵌入窗口。
5. **嵌入超长必须拆不可截**；记录 `embed_input_chars`。
6. **HNSW 过滤召回**：`ef_search` / `iterative_scan` + `source_id` B-tree 索引。
7. **修 Semantic 丢尾句、Fixed 丢空格**。
8. **日志 `status` 拆成 `hit|empty|error`**，空召回率进面板。

### P1 — 建立"知识版本 + 混合检索 + 引用反馈"（4–8 周）

1. **版本模型**（见第 4 节 DDL）：`docs / doc_versions / chunks(version_id)`，chunk id 改为 `hash(version_id, ordinal)`；支持 `as_of` 与回滚。
2. **内容哈希 + 幂等 + 去重**：`content_sha256` 相同直接返回既有版本；块级 diff 做增量重嵌。
3. **混合检索**：向量 + 词法（料号 trigram + 中文 FTS），RRF 融合（见第 5 节 SQL）。
4. **chunk 元数据**：`heading_path / page / char_range / table_id / chunk_strategy_hash`。
5. **引用协议 + retrievalId + 反馈 API**。
6. **MMR 去冗余**，条件允许加 rerank。
7. **策略作用域**：至少支持 per-document 覆盖 + 策略哈希 + stale 标记。
8. **异步索引流水线**：DB 任务表 + worker + 幂等 + 重试 + 并发 `embedTexts(4)`。

### P2 — 平台化（3–6 个月）

1. 多租户/集合/ACL（替代 `is_shared` 布尔）。
2. 评估体系：golden set + recall@k / nDCG / MRR + 回归门禁。
3. 查询理解：改写、多查询、领域同义词词典。
4. 结构化抽取：datasheet 参数表 → 结构化字段；表格感知切分。
5. 可观测：检索漏斗（候选→融合→重排→入选）、空召回率、分数分布、源覆盖率、陈旧率。
6. 安全：真实鉴权、key 哈希存储、限流外置、PII/密级过滤、检索结果注入防护。

---

## 4. 目标数据模型（DDL 草案）

```sql
-- 文档（逻辑实体，稳定的对外身份）
CREATE TABLE marmot_docs (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  type              TEXT NOT NULL,
  owner_id          TEXT NOT NULL,
  collection_id     TEXT,
  current_version_id TEXT,                 -- 检索只认这个
  is_shared         BOOLEAN NOT NULL DEFAULT FALSE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 版本（一次完整的索引快照）
CREATE TABLE marmot_doc_versions (
  id                TEXT PRIMARY KEY,       -- ver_<ulid>
  doc_id            TEXT NOT NULL REFERENCES marmot_docs(id) ON DELETE CASCADE,
  version_no        INTEGER NOT NULL,
  content_sha256    TEXT NOT NULL,
  source_uri        TEXT,
  effective_from    TIMESTAMPTZ,
  effective_to      TIMESTAMPTZ,            -- 时效：过期不再召回
  state             TEXT NOT NULL,          -- building | active | superseded | failed | rolled_back
  chunk_strategy    JSONB NOT NULL,         -- {type,size,unit,overlap,headingAware,tableAware}
  chunk_strategy_hash TEXT NOT NULL,
  embedding_model   TEXT NOT NULL,
  embedding_dim     INTEGER NOT NULL,
  chunk_count       INTEGER NOT NULL DEFAULT 0,
  error             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (doc_id, version_no)
);

-- 块（带定位与结构）
CREATE TABLE marmot_chunks (
  id                TEXT PRIMARY KEY,       -- sha256(version_id || ordinal) 前 32 位
  version_id        TEXT NOT NULL REFERENCES marmot_doc_versions(id) ON DELETE CASCADE,
  doc_id            TEXT NOT NULL,
  ordinal           INTEGER NOT NULL,
  text              TEXT NOT NULL,
  token_count       INTEGER NOT NULL,
  char_start        INTEGER,
  char_end          INTEGER,
  page_from         INTEGER,
  page_to           INTEGER,
  heading_path      TEXT,                   -- "3.2 电气特性 > 3.2.1 额定电压"
  table_id          TEXT,
  content_sha256    TEXT NOT NULL,
  embed_input_chars INTEGER NOT NULL,       -- 向量实际覆盖的字符数
  embedding         vector(2000),
  embedding_model   TEXT NOT NULL,
  tsv               tsvector,               -- 词法通道
  meta              JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ON marmot_chunks (doc_id, version_id);
CREATE INDEX ON marmot_chunks USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
CREATE INDEX ON marmot_chunks USING gin (tsv);
CREATE INDEX ON marmot_chunks USING gin (text gin_trgm_ops);   -- 料号/型号精确匹配
CREATE INDEX ON marmot_docs (current_version_id);
```

**切换语义**（这是"更新不真空"的核心）：

```sql
BEGIN;
UPDATE marmot_doc_versions SET state = 'active' WHERE id = $new;
UPDATE marmot_docs SET current_version_id = $new, updated_at = now() WHERE id = $doc;
UPDATE marmot_doc_versions SET state = 'superseded' WHERE doc_id = $doc AND id <> $new AND state = 'active';
COMMIT;
```

- 检索侧永远是 `JOIN marmot_docs d ON d.current_version_id = c.version_id`，切换是原子的；
- 构建失败 → `state='failed'`，`current_version_id` 不动 → **旧知识继续服务**；
- 保留 `superseded` 版本 N 天，支持 `as_of` 查询与一键回滚。

**并发写**：`POST /api/agent/sources` 改为 upsert 语义，要求 `expectedVersion`（或 `If-Match`）+ `Idempotency-Key`；不匹配返回 409 并附当前版本，让 Agent 走"读-改-写"。

---

## 5. 混合检索（RRF）SQL 草案

```sql
SET LOCAL hnsw.ef_search = 100;
SET LOCAL hnsw.iterative_scan = relaxed_order;

WITH params AS (
  SELECT $1::vector AS qv,
         plainto_tsquery('simple', $2) AS qts,
         $2::text AS raw
),
vec AS (
  SELECT c.id,
         ROW_NUMBER() OVER (ORDER BY c.embedding <=> (SELECT qv FROM params)) AS rnk
  FROM marmot_chunks c
  JOIN marmot_docs d ON d.id = c.doc_id
  WHERE d.current_version_id = c.version_id
    AND (d.owner_id = $3 OR d.is_shared)
    AND ($4::text[] IS NULL OR d.id = ANY($4))
  ORDER BY c.embedding <=> (SELECT qv FROM params)
  LIMIT 100
),
lex AS (
  SELECT c.id,
         ROW_NUMBER() OVER (
           ORDER BY ts_rank_cd(c.tsv, (SELECT qts FROM params)) DESC
         ) AS rnk
  FROM marmot_chunks c
  JOIN marmot_docs d ON d.id = c.doc_id
  WHERE d.current_version_id = c.version_id
    AND (d.owner_id = $3 OR d.is_shared)
    AND ($4::text[] IS NULL OR d.id = ANY($4))
    AND (
      c.tsv @@ (SELECT qts FROM params)
      OR c.text ILIKE '%' || (SELECT raw FROM params) || '%'   -- 料号直击
    )
  LIMIT 100
)
SELECT id, SUM(1.0 / (60 + rnk)) AS rrf_score
FROM (SELECT id, rnk FROM vec UNION ALL SELECT id, rnk FROM lex) u
GROUP BY id
ORDER BY rrf_score DESC
LIMIT $5;
```

要点：

- **RRF 而不是加权求和**：cosine 与 rank/BM25 不可比，`1/(60+rank)` 对两边都公平，且无需要调参。
- 料号查询走 `ILIKE`/`pg_trgm` 直击，不进语义通道——这类 query 语义相似度几乎无用。
- 词法通道同时提供**降级能力**：嵌入服务挂掉时至少还能返回字面命中（当前是直接 500）。

---

## 6. 对外契约演进（草案）

```http
POST /api/agent/retrieve
X-API-Key: mrmk_...
{
  "query": "CC0603KRX7R9BB104 的额定电压",
  "mode": "balanced",              // fast | balanced | deep
  "topK": 8,
  "budgetTokens": 3000,
  "filters": {                      // 取代裸 sourceFilter
    "docIds": ["doc_..."],
    "types": ["datasheet"],
    "effectiveAfter": "2024-01-01"
  },
  "asOf": null                      // 可选：历史版本检索
}
```

```json
{
  "retrievalId": "rtv_01J...",
  "status": "hit",
  "citations": [
    {
      "citationId": "c1",
      "chunkId": "a1b2c3...",
      "docId": "doc_...",
      "docVersion": 3,
      "title": "CC0603 系列规格书",
      "headingPath": "3.2 电气特性",
      "page": 12,
      "charRange": [340, 812],
      "score": 0.83,
      "source": "vector+lexical"
    }
  ],
  "context": "[c1] 额定电压 50V ...\n\n[c2] ...",
  "diagnostics": {
    "vectorHits": 12, "lexicalHits": 8, "fused": 5,
    "reranked": true, "bestScore": 0.83, "scoreGap": 0.12,
    "tookMs": 41
  }
}
```

```http
POST /api/agent/feedback
X-API-Key: mrmk_...
{
  "retrievalId": "rtv_01J...",
  "usedCitationIds": ["c1", "c3"],
  "verdict": "grounded",            // grounded | partial | unsupported
  "missingInfo": "没有给出温度系数"
}
```

三个字段各自解决一个问题：`citations` → 可核验；`status/diagnostics` → Agent 能决策；`retrievalId + feedback` → R 能被度量。

---

## 7. 怎么证明改进有效（度量）

先建 **golden set**：200–500 条 `(query, 期望 doc/section)`，从现有 `marmot_query_logs` 里挑真实 query 人工标注。没有这个，后面所有改动都是凭感觉。

| 指标 | 定义 | 目标方向 |
|---|---|---|
| Recall@10 | 期望段落进入前 10 的比例 | ↑ |
| MRR@10 | 首个正确结果的排名倒数均值 | ↑ |
| nDCG@10 | 排序质量 | ↑ |
| 空召回率 | `status=empty` / 总请求 | ↓ |
| 弱召回率 | `status=weak` / 总请求 | ↓（同时看是否被 Agent 改写后救回） |
| 引用使用率 | `usedCitationIds` 非空比例 | ↑ |
| grounded 率 | `verdict=grounded` 比例 | ↑ |
| 陈旧率 | 召回块中非 active 版本 / 超过 TTL 的比例 | → 0 |
| 更新可用性 | 重建期间检索成功率 | → 100% |
| p95 延迟 | 端到端 | 守住预算 |

**门禁**：任何切分策略、嵌入模型、融合权重、rerank 的改动，必须跑基线对比；任一核心指标退步 > 2% 即阻断合并。

---

## 8. 如果只做五件事

按投入产出排序：

1. **双缓冲版本切换**（B3 + B1 + B2）——消除"更新即下线"，同时拿到版本与引用定位。这一件事同时解决可用性、可追溯、可回滚。
2. **混合检索 + RRF**（A1 + A3）——对料号/术语类语料，这是单点收益最大的一项；顺带获得嵌入服务故障时的降级能力。
3. **chunk 元数据 + citation 协议**（E1 + C4）——让 Agent 的答案可核验，也让后续所有精排/评估有抓手。
4. **retrievalId + 反馈 API**（E2）——没有它，R 的质量永远只能靠感觉调。
5. **修三个数据正确性 bug**（A4 截断 / A5 token 计数 / C3 overlap 单位）——成本极低，但现在所有统计数字都不可信。

---

## 9. 两个判断，供讨论

**其一：不要为了"RAG 完整"而自己补 G。**
G 外包是正确的边界。真正要补的不是生成，而是**把 R 变成契约化的服务**：可引用、可判断充足性、可反馈、可版本化。这四件事做完，任何 Agent 接进来都能用好；做不完，换成自研 LLM 也只是把问题藏起来。

**其二：优先级的答案取决于语料，不取决于技术潮流。**
- 如果主战场是**规格书/料号/认证**（YAGEO 这类被动元件场景）→ **词法通道 + 表格感知切分** 是 P0，比换 embedding 模型重要得多；
- 如果主战场是**制度/流程/合同**→ **版本与时效** 是 P0，因为"用错版本"比"召回不全"后果更严重。

**已确认：主语料为制度 / 流程 / 合同。** 因此：

- **B（版本与时效）→ P0**，A1（词法通道）降为 P0.5，仅保留"文号 / 合同编号 / 条款号"的字面命中最小子集；
- 新增的一项 P0：**条款感知切分 + 条款级引用**（制度与合同的引用单元是"第几条"，不是"某段文本"）；
- 新增的一项 P0：**近重复抑制**（合同模板段落跨文件重复率极高，会挤占 top-k）。

收敛后的可排期清单见 [P0-任务清单-制度流程合同.md](./P0-任务清单-制度流程合同.md)（含依赖顺序、验收标准、人日估算）。
