# 流式修复设计：渲染与落盘解耦

**日期：** 2026-10-18
**用户决定：** "db 落盘和渲染我认为要分开，渲染流式输出，写入走统一的时间窗口，不记录实时的流式输出数据。"

## 现状：渲染被迫走 DB

```
provider token
  → ModelOutputStream.AddAsync          (256字符/100ms 合并)
  → publish(frame)
  → AppendEventAsync(model.output.delta)   [DB写 1: 事件表+JSONL]
  → AppendRunStreamAsync(answer.delta)     [DB写 2: run_stream表+内容落盘]
  → SSE GET /runs/{id}/stream
  → FollowAsync 每 150ms 轮询 ReplayRunStreamAsync  [DB读]
  → renderer
```

**问题不是某一处慢，而是渲染路径上挂了两次写 + 一次轮询读。**
任何一环慢，都会通过"攒批"反映成 UI 上的大跳变。

## 目标架构

```
provider token
  ├─→ [渲染通道] 进程内 pub/sub → SSE 直推  (零 DB, 零落盘)
  └─→ [落盘通道] 时间窗口聚合 → 定时合并写  (降频, 可丢中间态)
```

两个通道**互不阻塞**。渲染通道永不等 DB；落盘通道永不影响渲染。

## 关键设计决策

### 1. 渲染通道：内存广播

新增进程内 `IRunStreamBroadcaster`：
- `Publish(runId, chunk)` —— 内存 channel，无 await 的 DB 操作
- `Subscribe(runId, afterSeq)` —— SSE 端点订阅内存 channel
- 保留 `ReplayRunStreamAsync` 作为**重连续传**路径（cursor 落后时读 DB 补历史）

SSE 端点逻辑改为：
1. 先回放 DB 里 seq > cursor 的历史（重连场景）
2. 追上后切到内存 channel（实时场景）
3. 内存 channel 收到推送立即 `WriteAsync` + `FlushAsync`

这样正常流式渲染延迟 = 网络 RTT，不再是 150ms 轮询 + DB 查询。

### 2. 落盘通道：时间窗口聚合

用户说"不记录实时的流式输出数据"。具体做法：

- **`answer.delta` 不再逐帧落盘**，改为每 N ms（建议 500ms）把累计文本写**一条** `answer.delta`，
  其内容是这一窗口内所有 token 的拼接
- 或者在窗口边界只写**累计快照**（更简单，但会覆盖式语义，需前端配合）
- **终态必须完整**：run 结束时无条件 flush 一次，保证 DB 里的最终答案是全文

这样 DB 写入从"每 256 字符一次"降到"每 500ms 一次"，且不再阻塞渲染。

### 3. 崩溃恢复语义（必须守住）

当前 `run_stream` 是 durable 的：SSE 断开重连能续传、崩溃重启能恢复。
新架构必须保持：
- 落盘通道的窗口聚合**不能丢失终态**（run 终止前必须落全文）
- 内存通道丢了（进程崩溃）→ 客户端重连时走 DB 回放，最多丢当前窗口内的增量
- 这个降级是**可接受的**：用户看到"重连后少了一小段又补上"，比现在"整段突然出现"好

**但不能接受**：run 成功了但 DB 里没有完整答案。这是硬要求。

## 需要改动的文件（预估）

| 文件 | 改动 |
|---|---|
| `DmaEA/ModelOutputStream.cs` | 拆分：合并策略改为可配置，或直接透传细粒度给渲染通道 |
| `Abstractions/Ports/ILifecycleManager.cs` | 新增 broadcaster 端口 or 用现有 |
| `DmaEA/FullDuplexRunCoordinator.cs` | `FollowAsync` 改为 subscribe 内存 + 回放 DB |
| `DmaEA/FullDuplexRunEngine.cs` | `CreateModelFactory` 的 publish 回调分流到两个通道 |
| `AspNetCore/Endpoints/DmaeaEndpoints.cs` | SSE 端点接新 FollowAsync（签名可能不变） |
| `Lifecycle/StorageLifecycleService.cs` | 窗口聚合落盘 |

## 分阶段（建议）

**阶段 1（最小可用，见效最快）：只解耦渲染通道**
- 加 `IRunStreamBroadcaster`，engine 的 publish 同时推内存通道
- `FollowAsync` 改为"先回放 DB，再订阅内存"
- `ModelOutputStream` 的合并阈值降到 ~40ms 时间驱动（因为不再直接写 DB，可以更激进）
- DB 写入保持现状（每帧一次）
- **效果：渲染帧数从 2-3 提升到几十，肉眼流式。DB 写入量不变（可能略增）**

**阶段 2：落盘窗口聚合**
- DB 写入降频到 500ms/次
- 保证终态完整

阶段 1 就能解决用户报告的问题，且风险小得多。阶段 2 是性能优化。

## 风险

1. **内存广播的背压**：慢客户端会不会拖垮 engine？需要 bounded channel + 丢弃策略（丢弃时靠 DB 回放补）。
2. **多实例/多进程**：当前是单进程 Core，内存广播可行。若将来多实例，需要换 Redis 等——但那是 YAGNI，现在单进程。
3. **`FollowAsync` 是 IAsyncEnumerable，改造后要小心取消与清理**（现有代码已有 heartbeat/terminal repair 逻辑，不能丢）。
4. **测试面大**：`FullDuplexEndpointTests` 有大量流式断言，改动会牵动它们。

## 本文档状态

这是**设计提案**，不是已实施。等用户确认方向后再动手。
