# 监督升级不可见 / 无法回答 —— 根因与修法

## 现场（真实 run B4B56D9A，RouterAPI 项目，2026-10-18）

run 在 08:42:51 停在 `awaiting_user`，summary「Supervision requires user review before this run can finish」，
496 个事件，`run_stream` 只有 ack+queued，无答案帧。用户界面一直显示「正在起草」。

## Core 侧：升级本身是正确的

事件链：

```
08:42:41 worker.completed  x3   ← 三份取证都返回
08:42:42 worker.blocked         ← 其中一个任务 self-report blocked
08:42:49 supervision.requested       revision_round=2, result_count=3
08:42:49 supervision.skipped         no supervisor in frozen roster
08:42:49 supervision.completed       decision=escalate
08:42:51 supervision.user_review.requested  options=[continue,correct,cancel]
```

升级来自两个叠加条件，都是既有设计：

1. `EnforceTaskOutcomeFacts`：有任务 status != completed 且 unresolved（blocked 不是 failed，无法靠重规划解决），
   若还有未完成项 → `Decision = Revise`；`revisionRound(2) >= maxRevisionRounds` → `EnforceRevisionBudget` 转 `Escalate`。
2. 若**全部**任务失败且无 completed → 直接 `Escalate`。

`supervision.skipped` 只是说「这个 mode 的 frozen roster 里没有 supervisor 模型」，不等于「审查通过」；
跳过模型审查后，代码化事实检查（code-owned facts）仍然执行，这是**正确的**——否则没有监督员的 mode 会把
「一个任务 blocked」洗成 pass。

**结论：Core 没有错。缺陷在「裁决送达不到人」和「送达了也无法回答」。**

## 前端侧：三个独立缺陷

### 缺陷 1：裁决卡依赖一条脆弱的平行链路

`apps/TinadecUI/src/components/cards/home/ChatCard.vue:15`：

```js
supervisionReviews: Object.fromEntries(
  Object.entries(c.agentTurnActivities.value).map(([runId, turn]) => [runId, turn.supervisionReview ?? null]))
```

`agentTurnActivities` ← `useAgentActivity.turnActivities` ← `turns.value`（由 `saveTurn()` 填充）。
而 `saveTurn()` 只在 `activity.value.runId` 存在时写条目——它绑定的是**当前选中 run** 的活体状态机，
不是「哪些 run 有待裁决」。结果：

- 裁决发生在没被选中的 run 上 → map 里有 review，但 `turns` 里没这个 runId → 永不渲染；
- 页面 reload / 切换会话后重放 → `turns` 重建依赖 `activity.runId` 时序，review 可能孤悬。

同时 `reducer.ts`（对话流的真正事件归约器）**完全没有** `supervision.user_review.requested` 分支，
`CORE_EVENT_TYPES` 里却有这个类型。也就是说：同一条事实有两条事件消费链路，其中负责渲染的那条不认这个事件。

### 缺陷 2：「正在起草」判据仍把 parked 当 working（我已修一半）

上一轮我把 `run.live` 改成 `run.working`（= RUNNING 且非 AWAITING），已生效。
但如果 run 状态在界面上停留在 `executing`/`planning`（因为 `runs.value` 的刷新与 `loadMessagesAndApprovals` 耦合），
`working` 仍为 true → 闪烁持续。**这是「状态陈旧」而不是「判据错误」，需要实测确认。**

### 缺陷 3：升级后没有答案，界面只剩占位

`FinalizeAsync` 只有在 pass/skipped 时才产答案；escalate 路径 `checkpoint.MeetingResponse = null`。
所以一次升级的 run 永远没有正文。用户看到的是「一直在起草」，而实际上整个 run 已经停止产出。

## 修法（不动 Core 语义）

1. **让对话流自己的归约器认识这个事件**：`reducer.ts` 增加 `supervision.user_review.requested` 分支，
   产出 `kind:'supervision'` 节点（复用现有 `SupervisionGate` 渲染路径），不再依赖 `useAgentActivity` 的 turn map。
2. **把 review 作为 feed 的一等状态**：`FeedState` 增加 `reviews: Map<runId, {reasons, options, at}>`，
   由 reducer 维护，`turns.ts` 直接取，不经过 `agentTurnActivities`。
3. **删掉 ChatCard 里那条 map**，改为从 feed 取。
4. **占位符判据改为「有在产出的证据」**：`working` 之外再要求「最近有事件」或「状态属于 RUNNING」，
   并在 run 状态陈旧时不让它无限闪。

## 待实测确认

- 界面上的 run.status 是否真的陈旧到 `executing`（决定缺陷 2 是否真实存在）
- 卡死的 run 刷新页面后裁决卡是否出现（决定缺陷 1 的实际影响面）

## 后续实测（2026-10-18 20:58）

真实 Electron 重开该 run 后裁决卡和 continue/correct/cancel 均出现。更重要的是，业务事件此前其实一条都没到 renderer：`ScopedEventSource` 的原生 `fetch` 调用被绑定到实例，Electron 抛 `Illegal invocation`，错误随后被重连 catch 吞掉。修复为无绑定局部调用后，durable replay 恢复，监督 gate 才真正可见。阶段状态也已作为带图标的 `TurnWork` 步骤沉淀；完整记录见 `real-electron-verification.zh-CN.md`。
