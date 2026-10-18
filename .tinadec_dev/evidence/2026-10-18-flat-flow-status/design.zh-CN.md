# 平面模式：状态移入对话流（2026-10-18）

## 决定

1. **删掉 ChatHeader 的 run pills**（左上角标题下的「规划中/执行中/等待」胶囊）。
   它是对话区之外的第二套状态词汇，与对话流里的工作折叠重复。

2. **规划仍在对话流里，但改成「计划」折叠**，取代输入框上方的浮动胶囊 `AgentTodosStatus`。
   - 现状：`AgentTodosStatus` 浮在 ChatPanel 的 ConversationView 与 ComposerBar 之间，
     是对话流**外**的第三处状态显示；plan 本身也已经在 TurnActivity 里作为 `plan` 节点渲染一次。
   - 改成：plan 只出现在对话流里（`TurnActivity` 的 `plan` 节点，已存在），把浮动胶囊删除。
     理由与 Codex/Qoder 一致：计划属于这一轮的工作，应该随这一轮沉淀，而不是悬在输入框上方。

3. **等待人裁决必须在对话流里可见**，不能只靠删掉的 pills。
   现状 `SupervisionGate` 已在 turn 里渲染，但仅在 `supervisionReviews?.[run.id]` 有数据时。
   补一条：run 状态是 awaiting_* 但没有 review 时，turn 里显示等待行（不让用户看不到「在等我」）。

4. **「正在工作」的实时行由 TurnWork 承担**（已有：spinner + 白话步骤 + 计时）。
   它已经是对话流内的 live 状态行，删掉 pills 后再无重复。

## 不做的

- 不动 `useRunStore.selectedRunId` 的语义与 `fetchRuns`；pills 是它唯一的 UI，删掉后
  `selectedRunId` 仍被 WorkbenchPage 使用，保留。
- 不新增第二套状态词汇；继续用 `runStatusLabel`（`statusLabels.run.*`）。

## 验收

- ChatHeader 只渲染标题，没有任何 run 状态。
- 输入框上方不再有 todos 胶囊。
- 对话流里：live run 有工作折叠（含计划节点）；awaiting 有等待行。