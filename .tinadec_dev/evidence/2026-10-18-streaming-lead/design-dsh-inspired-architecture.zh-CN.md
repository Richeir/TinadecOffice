# 流式架构重构设计：日志 + 投影，渲染与落盘并行

**日期：** 2026-10-18
**依据：** 用户要求「架构理顺 + 工作过程可见」，参考 DeepSeek Harness 做法，并充分利用 Vue 特性。

---

## 一、DSH 是怎么做的（实测读源码，非推测）

从 `app.asar` 提取 `@deepseek-ai/dsh-session`、`dsh-session-projection`、`dsh-session-persistence` 三个包后读到的核心设计：

### 1.1 单一真相源：append-only 事件日志

`dsh-session/lib/types/surface.js` 开篇原话：

> *"Surface layer on top of the session event log: an ordered view of events that produce LLM messages. **The append-only log remains the source of truth.**"*

→ 日志只做追加、不可变；**渲染不是从日志直接读**，而是读「投影」。

### 1.2 投影层是独立服务，只吃「已提交」事件

`dsh-session-projection/lib/index.js` 原话：

> *"the registry that DRIVES every registered unit forward eagerly over **committed** session events"*

我读到的实现结构：

```js
var SessionProjectionRegistry = class extends Service {
  registrations = new Map();
  listeners = new Set();
  constructor(ctx) {
    super(ctx, "sessionProjections");
    ctx.on("session/created", (session) => { ... })
  }
}
```

- 只订阅一次 `session/event`
- 每个已提交事件过每个注册单元的 `apply`（**eager drive**）
- 只在 `Object.is` 变化时发变更通知
- 每会话维护 **watermark** 缓存，懒构建（新单元从 `init` 折叠内存日志）

### 1.3 三层分离，互不知道对方

> *"Domain host plugins contribute pure folds and optional client views; **the framework owns the subscription, the per-session watermark cache, and change notification**; carriers consume the snapshot read face and the change feed. **Neither side knows the other** (capability-seam three-way split)."*

**这就是用户说的「两条路」**：
- 落盘侧：`dsh-session-persistence`（写日志）
- 渲染侧：投影 registry + change feed（读投影）
- 中间：框架拥有的 watermark / 订阅 / 通知

### 1.4 一条关键规则（对我们尤其重要）

> *"**Whole-value event rule (load-bearing)**: a state-carrying log event MUST carry the complete post-change state, never a bare delta — it keeps every unit's transition trivially cheap and every served value self-describing."*

DSH 的日志事件存**完整状态**而非增量。这样投影折叠永远廉价，且每个值自描述。

---

## 二、我们现在的差距

| 维度 | DSH | TinadecOffice 现状 |
|---|---|---|
| 真相源 | append-only 事件日志 | `run_stream` 表（可追加，但被当渲染源用） |
| 渲染数据源 | 投影快照 + change feed | **每 150ms 轮询 `ReplayRunStreamAsync` 查表** |
| 落盘与渲染 | 两个独立模块 | **同一条路：先落盘才能渲染** |
| 变更粒度 | `Object.is` 变化才通知 | 每次 DB 查询 |
| 工作过程 | 投影视图可含任意折叠 | worker 文本进沉思块，正文只最后一个调用 |

**根因一句话**：我们把「持久化日志」直接当成了「渲染数据源」，所以渲染被迫等落盘。

代码位置：
- `FullDuplexRunCoordinator.cs:599` — `FollowAsync` 里 `while` 循环反复 `ReplayRunStreamAsync`
- `StorageLifecycleService.cs:1074` — `ReplayRunStreamAsync` 查 `db.RunStream` 表
- `FullDuplexRunCoordinator.cs:84` — `FollowPollInterval = 150ms`

---

## 三、目标架构

```
                    ┌─────────────────────────────────────┐
  provider token →  │  ModelOutputStream（不再合并，逐帧透传）│
                    └──────────┬──────────────────────────┘
                               │ 一帧 → 两条路，互不阻塞
              ┌────────────────┴────────────────┐
              ▼                                 ▼
   ┌──────────────────────┐        ┌──────────────────────────┐
   │ [渲染通道]            │        │ [落盘通道]                │
   │ IRunStreamProjection │        │ 时间窗口聚合 500ms        │
   │ 内存 watermark 缓存   │        │ 合并写 run_stream         │
   │ Object.is 变更通知    │        │ 终态无条件 flush 全文     │
   └──────────┬───────────┘        └──────────────────────────┘
              ▼
   ┌──────────────────────┐
   │ SSE 直推（零 DB 查询） │
   │ Gateway proxySse 已就绪│
   └──────────┬───────────┘
              ▼
   ┌──────────────────────┐
   │ Vue 投影视图          │
   └──────────────────────┘
```

### 3.1 渲染通道：`IRunStreamProjection`

对应 DSH 的 `sessionProjections`。Core 内部服务：

```csharp
public interface IRunStreamProjection
{
    // 每个已提交帧 eager drive 所有注册单元
    void Apply(RunStreamFrame frame);

    // 快照读（重连时用）
    RunStreamSnapshot Read(Guid runId, long afterSeq);

    // 变更 feed（SSE 订阅）
    IAsyncEnumerable<RunStreamFrame> Follow(Guid runId, long afterSeq, CancellationToken ct);
}
```

要点：
- **内存 watermark**：每 run 维护 `observedSeq`，避免每次查 DB
- **变更通知**：内容真变了才通知（序列号比较）
- **回放兜底**：`afterSeq` 落后于内存窗口时，回落 `ReplayRunStreamAsync` 读 DB
- **bounded channel**：慢客户端丢弃中间帧，靠 DB 回放补齐（不阻塞 engine）

### 3.2 落盘通道：窗口聚合

按用户要求「写入走统一的时间窗口，不记录实时的流式输出数据」：

- 每 500ms 窗口：把该窗口内的帧**合并成一条** `run_stream` 行
- 终态（`done`/`error`）**无条件 flush**，保证 DB 有完整答案
- 幂等键保留，崩溃恢复语义不变

⚠️ **注意 DSH 的 whole-value 规则**：窗口聚合若写「增量拼接」，回放需累加；若写「累计快照」，回放是覆盖。**建议存累计快照**，回放简单且自描述。

### 3.3 SSE 端点改造

`DmaeaEndpoints.cs:32` 的 `GET /runs/{runId}/stream`：

```
现在：await foreach (chunk in coordinator.FollowAsync(...))  // 内部每150ms轮询DB
改成：
  1. 先 projection.Read(runId, cursor) 回放内存快照
  2. 补齐后 projection.Follow(runId, cursor) 订阅变更 feed
  3. DB 回放仅作为冷启动/越界兜底
```

Gateway 侧 `proxySse` 已是零缓冲透传（`coreClient.ts:160`），**不用改**。
---

## 四、工作过程可见（用户第二个要求）

### 4.1 现状问题

真实 run `6E36E2E4`：总 85.8s，正文流动 0.3s（**0.4%**）。前 74 秒是多轮工具调用 + 推理。

worker 的 `ch=text` 经 `reducer.ts:436` 进 `ReasoningEntry.output`，由 `ReasoningBlock.vue:58` 以正文色渲染 —— **技术上可见**，但用户不认为那是「回答」。

全库 5 条 completed run 的正文占比：0.4% / 1.1% / 2.4% / 7.3% / 15%。中位数约 2–7%。

### 4.2 改法：把「工作过程」提升为一等公民

参考 DSH 的 surface 分层（`SURFACE_EVENT_TYPES` 明确区分 `system/user/assistant/tool-result`），我们也应该区分：

| 层 | 内容 | 渲染 |
|---|---|---|
| **答案层** | meeting 的最终 `answer.delta` | 正文区，逐字长 |
| **工作层** | worker 的 `ch=text` + 工具调用 | 可折叠「工作过程」区，默认展开、实时流 |
| **沉思层** | `ch=reasoning` | 现有 ReasoningBlock |

关键改动：
1. worker 的 `ch=text` 不再塞进 `ReasoningEntry.output`（那是沉思块的附属），而是独立成**工作步骤条目**，有标题（「search#1 正在整理结果」）、有正文流
2. 答案区在 `answer.started` 前显示「正在作答」占位，把静默变成可感知
3. 折叠策略：运行中默认展开，结束后自动折叠（复用现有 `useAutoDisclosure`）

### 4.3 充分利用 Vue 特性

当前为 Vue 3.6（Vapor + interop）。可用于流式高频更新的：

| 特性 | 用在哪 |
|---|---|
| `shallowRef` | 流式帧数组用 shallowRef，避免深层响应式代理开销（高频更新关键） |
| `computed` 缓存 | 投影视图（答案文本、工作条目列表）用 computed，依赖不变不重算 |
| `v-memo` | 历史消息列表用 `v-memo`，流式更新时不重渲染已完成的消息 |
| `onBeforeUnmount` | SSE 订阅生命周期清理 |

⚠️ **不要做的事**：
- 不要引入 `requestAnimationFrame` 节流（实测 `useSmoothText` 只加 0.3s，不是瓶颈）
- 不要改 `projectRunReply`（逻辑正确，实测无闪替）
- 不要调小 256 阈值（实测 26 帧中只有 1 帧触及）

---

## 五、实施顺序

### 阶段 A：渲染通道解耦（架构理顺）
1. 新增 `IRunStreamProjection` + 内存实现
2. `FullDuplexRunEngine` 的 publish 回调：同时 `projection.Apply` + `AppendRunStreamAsync`
3. `FollowAsync` 改为 projection 优先、DB 兜底
4. `ModelOutputStream` 合并策略放宽（不再直接写 DB 后可激进）
5. 测试：`FullDuplexEndpointTests` 全绿

### 阶段 B：落盘窗口聚合
1. 窗口聚合器（500ms），终态强制 flush
2. 崩溃恢复测试（终态必须完整）

### 阶段 C：工作过程可见（用户真正能感知的变化）
1. `answer.started` 前占位
2. worker `ch=text` 独立成工作步骤条目
3. Vue 渲染优化（shallowRef / v-memo）

---

## 六、风险与诚实边界

1. **我读的 DSH 是 minified bundle**，注释保留但实现细节可能被压缩。上面引用的是**注释原文**和可辨识结构，不是逐行逆向。
2. **DSH 的 Cordis 服务模型与我们的 DI 不同**，不能照搬，只能借鉴分层思想。
3. **多实例风险**：内存投影只在单进程有效。当前 Core 是单进程，可行；将来多实例需换 Redis 等。
4. **实施面大**：`FullDuplexEndpointTests` 有大量流式断言，改动必然牵动。
5. **最重要的诚实提醒**：阶段 A+B 做完，**用户看到的流式感不会有明显改善**，因为正文本身只存在 0.3 秒。真正改善观感的是阶段 C。
6. 全库只有 5 条 completed run 样本，集中在 10-13 / 10-17，不外推到所有模型。

---

## 七、一句话总结

DSH 的答案是：**日志是真相，投影是视图，两者由框架连接但互不知晓**。
我们现在把日志直接当视图用，所以渲染被落盘绑死。
照 DSH 的分层重做，渲染走内存投影、落盘走窗口聚合，同时把工作过程提升为可见层。