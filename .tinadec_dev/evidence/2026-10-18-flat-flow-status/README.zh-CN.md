# 平面模式状态移入对话流（2026-10-18）

## 改了什么

三处「对话流之外的状态显示」收进对话流：

| 位置 | 原来 | 现在 |
|---|---|---|
| `ChatHeader.vue` | 标题下一排 run 胶囊（规划中/执行中/等待…），最多 4 个，可点选 run | **删除**，表头只剩标题 |
| `ChatPanel.vue` | 输入框上方浮动 `AgentTodosStatus` 计划胶囊，可展开 | **删除**（组件一并删除，71 行 + 测试） |
| `ConversationTurn.vue` | `run.live` 就显示「正在起草…」 | 拆成 `working` / `parked`：只有真在产出才显示闪烁占位，等待人时显示静态等待行 |

计划本身仍在对话流里：`TurnActivity` 的 `plan` 节点渲染 `AgentTodos`，与思维块、工具行同一层。

## 为什么删而不是改

1. **胶囊是同一事实的第三份投影**。run 状态在对话流里已有三处真实表达：工作折叠的 live 状态行（spinner + 白话步骤 + 计时）、`plan` 节点、`SupervisionGate`。表头那排胶囊不携带额外信息，却在读者视线之外，并且用了一套独立的「胶囊词汇」。Codex / Qoder / Claude Desktop 都没有第二套表头状态。
2. **计划胶囊与 plan 节点重复**。`AgentTodosStatus` 浮在流外、`AgentTodos` 在流内，两者读同一个 `PlanEntry`。删掉流外那个之后，计划跟着这一轮沉淀，符合「工作属于这一轮」的语义。
3. **删除让 `useRunStore.selectedRunId` 在对话里失去唯一 UI**。它仍被 `WorkbenchPage` 使用，语义未改；对话内不再有 run 切换器——同会话并行 run 由对话流按 turn 自然分行，不需要手动选。

## 顺带修掉一个我自己引入的缺陷

上一轮（2026-10-18 流式重构第 7 步）加的占位符判据是 `run.live`，而 `isLiveRunStatus` 把 `awaiting_user` / `awaiting_approval` / `awaiting_delegate` 也算 live。结果是**一个等待人裁决的 run 会永久显示闪烁的「正在起草…」**——正是用户报告的「一直在规划中」的观感来源之一。

现在 `lib/conversation/turns.ts` 新增 `isParkedRunStatus`（= AWAITING 集合），`ConversationTurn` 据此区分：

- `working`（RUNNING 集合）：显示闪烁占位，代表真在产出；
- `parked`（AWAITING 集合）：显示静态等待行（`conversation.turn.awaiting.*`），无动画。

等待行在没有 `SupervisionReview` 时才显示——有 review 时由 `SupervisionGate` 给出可操作选项，不重复。

## 验证

| 检查 | 结果 |
|---|---|
| `vue-tsc --noEmit` | 通过 |
| conversation 组件套件 + ChatHeader + ChatPanel + locales | **71/71** |
| 全量 desktop 套件 | 见下 |

新增/改写的测试：

- `ChatHeader.test.ts` 重写为三条：标题渲染、无会话时回退、**表头不含任何 run 状态词**（钉住删除）。
- `ConversationTurn.test.ts` 新增：三种 awaiting 状态各显示对应静态等待行且**不**显示闪烁占位；有 supervision review 时让位给 gate。
- `AgentTodosStatus.test.ts` 随组件删除。

## 未做 / 边界

- **未做真实 Electron 视觉验收**。折叠后的观感、等待行的颜色与位置需要真机确认。
- 侧边栏「详细显示」这次没有新建。现有 `AgentActivityPanel`（右栏「智能体活动」卡，含 `SubAgentsPanel` 名册）已经是详情去处；是否要在左侧栏再加入口，需要你先看删除后的对话流再决定，避免又造一处重复。
- `runStatusLabel` / `statusLabels.run.*` 仍被其他地方使用（工作台、审批面板），未删。