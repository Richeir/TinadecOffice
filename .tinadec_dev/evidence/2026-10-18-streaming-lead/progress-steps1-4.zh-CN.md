# 流式重构进度报告（步骤 1-4 完成）

**日期：** 2026-10-18
**分支：** main（工作树，未提交）

---

## 步骤 1 ✅ 补 streamAnswer

追问回复路径 `FullDuplexRunEngine.cs:4652` 加 `streamAnswer: true`。
之前这条路径**完全没有** `answer.started` / `answer.delta`。

## 步骤 2 ✅ 答案落地统一路径（删除 delta 冗余）

新增 `AnswerDraft`：流式 `Append`、非流式 `SetWhole`、终态统一发布。
删掉 `run_stream` 的 `kind="delta"` 全文行——它让同一个答案在库里存了三份。

**实测验证（真实库 5 个 completed run）：**

| run | answer.delta 累积 | messages.content | 结果 |
|---|---|---|---|
| 1AD5BA8C | 207 ch | 207 ch | 相等 |
| 29A7F645 | 261 ch | 261 ch | 相等 |
| 6E36E2E4 | 337 ch | 337 ch | 相等 |
| 94FC4AD7 | 1474 ch | 1474 ch | 相等 |
| F3C56554 | 346 ch | 346 ch | 相等 |

5/5 逐字节相等，且各帧长度非单调（268,201,34,22）证明是增量。**删 delta 安全。**

前端 `runReply.ts` 从 12 行含 `provisional` 状态机降到 **8 行纯累加**。
`HomeController.ts` 删掉 `provisionalReplies` 集合及 4 处引用。

## 步骤 3 ✅ streamAnswer 布尔 → AnswerStreaming 枚举

```csharp
internal enum AnswerStreaming { None, WorkLayer, AnswerLayer }
```

12 处 `CreateModelFactory` 调用全部显式标注，不再依赖默认值：

| 层 | 调用点 |
|---|---|
| AnswerLayer | 追问回复、会议答案 |
| WorkLayer | worker 模型轮次 |
| None | planner×2、supervisor、4 处治理派发 |

**诚实说明：`WorkLayer` 目前只是命名，行为与 `None` 相同**——
worker 文本本来就走事件表（`channel=text` → `ReasoningEntry.output` → `ReasoningBlock`），
这条通路已存在。枚举的价值在于让每个调用点声明意图，并为步骤 4 的投影层留出层次区分点。

## 步骤 4 ✅ 内存投影（渲染不再经过 DB）

新增 `RunStreamProjection`：写入后发布位置，读取方等待信号而非轮询。

**数据流变化：**

```
改前：engine 写 DB → FollowAsync 每 150ms 查 DB → SSE
      （渲染延迟下限 = 轮询间隔 + 一次查询）

改后：engine 写 DB（返回后）→ projection.Publish → FollowAsync 读内存 → SSE
      DB 仍是唯一真相；投影只是位置缓存，丢失即降级回 replay
```

**关键设计约束（都已落实）：**

1. **先写后发布**：publish 只在 `AppendRunStreamAsync` 返回后执行，
   所以读者永远不会看到崩溃会丢失的 token。
2. **空 buffer 不算覆盖**：`Covers` 对空 buffer 返回 false，
   否则跟随者会静默跳过存储里的历史帧。
3. **每轮重评估数据源**：跟随者可以从中途 replay 切到 live，不必等整轮结束。
4. **游标落后即降级**：`Covers` 检查保留窗口是否还够得着游标，够不着就回 DB。

## 顺带删掉的「谎言」

原 `FollowAsync` 有一段 `terminalRepairAttempts` 补丁：读不到 `done` 帧时
重试 3 次 `ReconcileTerminalRunAsync`，仍失败就**伪造一个 `done` 帧**（`FinishReason: "completed"`）
交给前端——前端无法分辨真假。

新实现里 done 帧由写它的同一段代码发布，不再需要「事后发现并修补」，
该补丁整段删除。终态缺失时直接汇报**持久状态**（`cancelled`/`failed`/`completed`），不再伪造。

---

## 验证结果

| 检查 | 结果 |
|---|---|
| `TinadecCore.DmaEA` 编译 | ✅ |
| `TinadecCore.Api` 全量编译 | ✅ |
| `RunStreamProjectionTests` | ✅ **10/10** |
| `Dmaea` 端点回归 | ✅ **8/8** |
| 新增投影端到端测试（真实 DI） | ✅ **1/1** |
| `runReply.test.ts` | ✅ **4/4** |
| `vue-tsc --noEmit` | ✅ 无错误 |
| Desktop 全量 | 1373 通过 / 1 失败（**既有失败**） |

### 那个既有失败

`HomeController.test.ts` 的 `resumes the same run cursor after host recovery` 失败，
`AssertionError: expected 'open' to be 'closed'`。
**已用 git stash 把我的改动全部暂存后复现同样失败**，与本次重构无关。

---

## 数据模型净变化

```
改前：messages.content + run_stream(kind="delta") + run_stream(kind="answer.delta")
      = 同一个答案存 3 份

改后：messages.content + run_stream(kind="answer.delta")
      = 权威消息 + 唯一流式表示（逐帧或单帧全文）
```

---

## 还没做的

| 步骤 | 内容 |
|---|---|
| 6 | 落盘窗口聚合（500ms + 终态强制 flush） |
| 7 | Vue 工作过程渲染（worker 文本独立条目、answer.started 前占位） |

---

## 诚实边界

1. **投影不会让流式「看起来更快」**，因为正文本身只存在 0.3–15% 的运行时长。
   它解决的是架构问题（DB 不在渲染路径上），不是观感问题。
2. 样本只有 5 个 completed run，不外推到所有模型/场景。
3. 我没有在真实 Electron 里做视觉确认，最终观感需用户验收。
4. `WorkLayer` 枚举目前无独立行为，是步骤 7 的前提而非成果。