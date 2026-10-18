# 流式输出重构：最终报告

**日期：** 2026-10-18  
**分支：** main（工作树，未提交）  
**范围：** 7 个步骤，6 个执行，1 个基于测量否决

---

## 你最初的问题

> 好像完全没有流式输出这个概念……纯粹是输出完以后突然显示。

## 答案是：流式机制一直在工作，但你 70%–86% 的时间看不到任何东西

从真实库 5 个 run 量出的时间线：

| run | run 开始 → 答案开始 | 答案窗口 | **什么都没有的时间** |
|---|---|---|---|
| 1AD5BA8C | 19.1 s | 8.5 s | **69%** |
| 29A7F645 | 12.7 s | 3.7 s | **77%** |
| 6E36E2E4 | 74.1 s | 11.7 s | **86%** |
| 94FC4AD7 | 36.3 s | 13.4 s | **73%** |
| F3C56554 | 62.8 s | 18.9 s | **77%** |

答案到达之后，帧是**健康的**：每 200–300ms 一帧、152–299 字节、持续数秒。
所以你看到的「突然显示」，是**前面那 12–74 秒的空白**造成的错觉，
不是最后几秒没有流式。

## 排查结论：不是重复模块，不是断链

你怀疑的两个方向我都查了：

- **重复模块**：不存在。渲染路径只有一条 `FollowAsync → SSE → projectRunReply`。
- **漏接**：确实有一处——追问回复路径（`:4652`）完全没开流式。已修。
  但那不是你日常问候场景的主因。

真正的成因是**结构性的**：

1. 答案在 Core 里要等 meeting 阶段才产生，前面 planning/dispatch/worker 跑几十秒
2. 这段时间界面上没有「答案区」，只有折叠的活动日志（12px 灰字）
3. 于是一旦答案出现，视觉上是「凭空冒出」

---

## 做了什么

### 1. 补上漏接的流式（唯一真实断链）

追问回复路径加 `AnswerStreaming.AnswerLayer`。之前这条路径零 `answer.delta`。

### 2. 删掉同一个答案在库里存三份的冗余

**改前：** `messages.content` + `run_stream(kind="delta")` + `run_stream(kind="answer.delta")`
**改后：** `messages.content` + `run_stream(kind="answer.delta")`

安全性是**逐字节验证**的，不是推断：

| run | answer.delta 累积 | delta 行 | 字符 | 字节 |
|---|---|---|---|---|
| 1AD5BA8C | 207 | 207 | 相等 | 525 = 525 相等 |

5/5 run 全部相等。各帧长度 110/73/16/8 证明是真增量。

顺带发现并删掉一个**危险的兜底猜测**：`runStream.ts` 原本在帧没有 `kind` 时
默认当成 `'delta'`。`delta` 这个 kind 消失后，这个兜底会把异常帧静默丢弃。
改成显式返回 null——契约破坏应该可见，不该被猜掉。

### 3. 布尔换成枚举，让每处调用声明意图

```csharp
internal enum AnswerStreaming { None, WorkLayer, AnswerLayer }
```

12 处 `CreateModelFactory` 全部显式标注。原来的 `streamAnswer` 布尔只能回答
「流不流」，而真实问题是「流到哪一层」——solo dispatch 下 meeting 同时是 worker。

### 4. 渲染不再经过 DB

```
改前：engine 写 DB → FollowAsync 每 150ms 查 DB → SSE
改后：engine 写 DB（返回后）→ 内存投影 → FollowAsync 按信号唤醒 → SSE
```

四条承重约束：**先写后发布**、**空 buffer 不算覆盖**、**每轮重评估数据源**、
**游标落后即降级**。DB 仍是唯一真相，投影丢了只影响速度。

### 5. 删掉伪造 done 的补丁

旧 `FollowAsync` 读不到 `done` 帧时重试 3 次，仍失败就**伪造**一个
`FinishReason: "completed"` 交给前端——前端无法分辨真假。
现在终态缺帧时如实汇报持久状态。

### 6. 落盘窗口聚合：**基于测量否决**

你原本的方向是「写入走统一时间窗口」。我量了：

| | 数值 |
|---|---|
| 平均帧数/run | **5.2** |
| 500ms 聚合能省 | **10 次 SQLite 写入**（全样本 26 → 16 帧）|

为省 10 次本地写入引入窗口缓冲、终态 flush、崩溃处置、与投影时序协调——
**不值得**，而且会让最后 500ms 的正文有丢失风险（当前「写盘后才发布」的性质更值钱）。

### 7. 让静默期不再空白（你真正能感知的部分）

run 活跃但还没有答案文本时，在**答案该出现的位置**渲染呼吸中的「正在起草…」。

不是放在活动折叠块里——那里已经有「正在思考」，但那是 12px 灰字；
用户的视线落在答案区，占位就该在那里。

---

## 验证

| 检查 | 结果 |
|---|---|
| `TinadecCore.Api` 全量编译 | ✅ 已成功生成 |
| `RunStreamProjectionTests` | ✅ **10/10** |
| `Dmaea` 端点回归 | ✅ **8/8** |
| 投影端到端（真实 DI） | ✅ 1/1 |
| `runReply.test.ts` + `HomeController.test.ts` | ✅ **50/50** |
| 新增 `ConversationTurn.test.ts` | ✅ **4/4** |
| 对话组件套件 | ✅ **55/55** |
| `vue-tsc --noEmit` | ✅ 干净 |
| 桌面全量 | 1377 通过 / 1 失败（**抖动**）|

### 关于那个失败

全量跑时 `message-scroller` 挂了 1 条，**隔离单跑 5/5 通过**。
上一轮全量挂的是另一条（`HomeController` 游标），这轮那条通过了。
失败点在移动 → 负载抖动，不是回归。
更早我还用 `git stash` 把我的改动全部暂存，复现过同类既有失败。

---

## 诚实边界（重要）

1. **我没有在真实 Electron 里看过最终观感。**
   测试证明的是渲染条件与 DOM 存在，不是「看起来舒服」。**需要你验收。**

2. **流式的「体感」不会因为这个重构变快。**
   正文本身只存在 0.4%–15% 的运行时长，没有传播延迟可优化。
   第 7 步的占位解决的是「看起来在干活」，不缩短实际等待。

3. **真正缩短等待是另一条线**：提高模型首字延迟、减少前置步骤。本次没动。

4. 样本只有 5 个 completed run，不外推到所有模型/场景。

5. 未验证：PostgreSQL 路径、真实外部模型端到端。

---

## 文件变更

**新增：**

| 文件 | 作用 |
|---|---|
| `DmaEA/AnswerDraft.cs` | 答案的唯一累积器 |
| `DmaEA/AnswerStreaming.cs` | 取代 bool 的层次枚举 |
| `DmaEA/RunStreamProjection.cs` | 内存投影，渲染不再过 DB |
| `tests/.../RunStreamProjectionTests.cs` | 投影语义 10 例 |
| `.../ConversationTurn.test.ts` | 占位行为 4 例 |

**修改：** `FullDuplexRunEngine.cs`、`FullDuplexRunCoordinator.cs`、`DmaEAModuleRegistrar.cs`、`ConversationTurn.vue`、`runReply.ts`、`runStream.ts`、`HomeController.ts` + 3 个测试文件 + `TinadecCore/AGENTS.md`

**净变化：** 11 文件改动 +296/−107，新增 5 文件。

**删除：** 2 个前提已被推翻的探针测试文件。