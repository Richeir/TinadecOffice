# 交接文档：流式输出 + 平面模式状态重构 + 监督裁决可回答化

生成时间：2026-10-18 17:30 (+08:00)
分支：`main`，HEAD `ae5c213a`，与 origin/main 齐平（0 ahead / 0 behind）
工作树：28 文件改动，+499 / -409，另有多份新增未跟踪文件

> **2026-10-18 20:58 后续更新**：本文第三节的两项未完成均已收口。真实 Electron 找到 SSE 断流的根因（原生 `fetch` 被当实例方法调用，`Illegal invocation` 被吞），修复后旧监督会话的裁决卡与三个按钮可见可答。阶段状态已改为 `TurnWork` 内带图标的可沉淀步骤，真实模型依次出现“正在规划 → 正在思考 → 正在起草 → 回答”。Vite 冷缓存卡死改为显式首屏依赖优化。完整证据与 run/message ID 见同目录 `real-electron-verification.zh-CN.md`；下表保留为修复前状态。

---

## 一、用户要什么（原话要点）

1. 流式输出「好像完全没有」——设置页宣称支持，实际是输出完突然显示。要求彻底排查是漏接还是模块重复叠加。
2. 架构方向：**db 落盘与渲染分开**，渲染走流式，写盘走统一时间窗口，不记录实时流式数据；两条路并行，Core 内部做对齐/同步/注入。
3. 参考 DeepSeek Harness，同时充分利用 Vue 特性。
4. **慢慢来 ≠ 不改**：要更稳妥更彻底的重构，「不该有的地方就重构，不兼容的地方就不兼容」。已批准 Plan B（AnswerDraft）与全部 7 步。
5. 平面模式：左上角「计划中/执行中」删掉，状态进对话流，学 Codex / DeepSeek Harness / Claude Desktop。
6. 「正在起草」「正在规划」这类状态**要留在界面上不消失**，而且**要有图标**（起草配笔）。
7. **当前请求**：自己全链路测试 + 全链路修复，然后用 **Electron 真实测试、真实发消息**。要求彻底修底层、逻辑清晰、可靠、可集群、高并发、稳定安全高效轻量。

---

## 二、已完成并验证的部分

### 2.1 平面模式表头清理（已通过验证）

- `ChatHeader.vue`：116 行 → 24 行，删除全部 run-pills（计划中/执行中/等待等），只剩标题。
- `ChatHeader.test.ts`：重写为 3 个测试，并**反向断言**不得再出现 `run-pills`、`.run-pill` 和状态词。
- `AgentTodosStatus.vue` + `.test.ts`：**已删除**。它是死代码（唯一消费者已移除），且与对话流里的 `plan` 节点读同一份 `PlanEntry`，属重复模块。
- 5 个 locale 全部清理：删 `conversation.plan.capsule`、`chat.latestRun`；新增 `conversation.turn.awaiting.{awaiting_user,awaiting_approval,awaiting_delegate,generic}`。

### 2.2 监督裁决（supervision escalation）修复 —— 本轮核心成果

**根因（有真实数据佐证，见 `.tinadec_dev/evidence/2026-10-18-supervision-gate/rootcause.zh-CN.md`）**：

Core 把 run 停在 `awaiting_user` 并发出 `supervision.user_review.requested`（options: continue/correct/cancel），
但前端渲染这条事实依赖一条**脆弱的平行链路**：

```
ChatCard.vue 从 agentTurnActivities 重建 map
  ← useAgentActivity.turnActivities
  ← turns.value（必须由 saveTurn() 写入）
  ← 只在 activity.value.runId 存在时写条目
```

即：**只有被选中/正被跟踪的 run 才可能在 turns 里有条目**。裁决发生在别的 run 上 → map 里有 review 但渲染不到。
与此同时 `reducer.ts`（对话流真正的归约器）**完全没有** `supervision.user_review.requested` 分支，
尽管 `CORE_EVENT_TYPES` 里有这个类型。→ 同一条事实两条消费链路，负责渲染那条不认它。

**已修（全部 vue-tsc 0 错、测试通过）**：

1. `reducer.ts`：
   - `RunActivity` 新增 `review: { reasons, options, at } | null`（**run 状态，不是日志行**，所以能扛住重整、折叠和重开会话）。
   - 新增 `supervision.user_review.requested` 分支写入它；`supervision.user_decision` 与 `context.goal_adjusted` 清除它。
2. `grouping.ts`：`GroupedRun` 增加 `review`，`groupRun` 直接透传 `record.review`。
3. `ConversationTurn.vue`：`RunView.review` 从 `grouped.review` 取（feed 优先），`gateReview()` 适配成 `SupervisionReview`（未知 option 不变成按钮，全不识别时回退三选项）。旧的 `supervisionReviews` 路径仅作兜底。
4. **`TurnWork.vue` 拆分语义**（重要设计决定）：原来一个 `live` 同时控制三件事，导致 parked 的 run 无法既保持展开又不闪。现在拆成：
   - `working`：真在产出 → spinner + 实时步骤 + 计时器
   - `openByDefault`：还在飞行中（含 parked）→ 折叠默认展开
   - parked 时表头显示**静态**等待行（带 `ShieldAlert` 图标 + 警示色），不再是无限「正在思考」。
5. 删除 `ChatCard.vue` / `ChatPanel.vue` / `ConversationView.vue` 里 `supervisionReviews` 的透传与 import（重复链路清除）。
6. 新增 `apps/desktop/src/lib/conversation/reducer.supervision.test.ts`：6 个测试（记录 reasons/options、重放不丢、决策后停止、`goal_adjusted` 后停止、无关事件不影响、缺字段容错）。

### 2.3 验证结果（截至交接）

| 项目 | 结果 |
|---|---|
| `npx vue-tsc --noEmit` | **exit 0** |
| 全量 desktop 测试 | **1380 passed / 12 skipped**（166 文件通过） |
| 新增 supervision 测试 | 6/6 通过 |
| 新增 `ConversationTurn.test.ts` | 通过（含 parked 三态断言） |

---

## 三、未完成 / 下一步

### 3.1 真实 Electron 端到端（用户明确要求，未完成）

已完成基础设施（**可以继续用**）：

- 独立测试栈已起好，数据目录 `C:/git/agent/TinadecOffice/.tinadec_dev/tmp/e2e-home`（**全新空库，2.1MB**）：
  - Core `127.0.0.1:48741`（PID 12636）
  - Gateway `127.0.0.1:48740`（PID 49648）
  - Vite `127.0.0.1:5183`（PID 48736）
  - 启动脚本：`.tinadec_dev/tmp/start-{core,gateway,vite,electron3}.ps1`
  - token：`.tinadec_dev/tmp/e2e-home/token.txt`（43 字符 base64url）
- CDP 驱动已可用：`.tinadec_dev/tmp/cdp-lib.mjs`（`connectToPage()` + `evaluate()` + `send()`），`ws` 已装，**不需要装 puppeteer**。
- 已验证：Electron 能起来，页面 `#app` 存在，CDP 能连，`title=TinadecOffice`，url=`http://127.0.0.1:5183/`。

**卡住的地方**：页面 `document.body.innerText.length === 0`，即 Electron 窗口里的 Vue 应用没渲染出内容。原因未查明（上一步抓控制台日志的脚本被中断，没拿到结果）。

**下一步建议顺序**：
1. 用 CDP 抓 `Runtime.consoleAPICalled` + `Runtime.exceptionThrown`，看渲染为何空白。注意：你原来的实例（见下方禁令）连的是 5173 端口且正常工作，所以**更可能是 5183 这套独立 Vite 的依赖缓存或 HOST token 校验问题**，而不是代码问题。
2. 若只是测试栈问题：直接复用**用户正在跑的那套**（5173/48730/48731）做交互测试，但**必须只读、绝不重启/杀进程**。
3. 拿到 UI 后，真实发一条消息，观察：起草占位 → 工具调用 → 监督裁决卡是否出现且可点 continue/correct/cancel。

### 3.2 「正在起草/正在规划」图标与常驻（用户明确要求，未做）

要求原话：「应该留在界面上，而不是弄完以后就直接消失了。而且需要有图标」。

- 位置：`TurnWork.vue` 的 `status` computed（`:51-61`）产出文案，模板 `:87-91` 渲染 spinner + shimmer 文本。
- 需要：给「起草」配笔类图标（lucide `PenLine`/`Pencil`），「规划」配列表图标（`ListChecks`/`List`）；文案消费完**不要立刻消失**。
- `@lucide/vue` 已在用（`TurnWork.vue` 已 import `ChevronRight`、`ShieldAlert`，`ConversationTurn.vue` import `RotateCcw`）。
- 相关 locale key：`conversation.reasoning.drafting` / `conversation.reasoning.thinking`。

### 3.3 已知但未修的深层问题（有证据，别当新发现）

1. **真实卡死 run（旧库 `C:/git/agent/RouterAPI/.tinadec/data/tinadec.db`）**：
   - run `B4B56D9A-2270-4BA1-994A-15895DD51F71`，session `4F9E63F7-8984-4798-93ED-08A4C939B5E8`（标题「请你介绍这个项目」）
   - 状态 `awaiting_user`，496 事件，`run_stream` **只有 ack+queued，零答案帧**
   - 事件链：41 次工具调用 → 3 轮 `worker.tool_round` → `worker.completed` ×2 + `worker.blocked` ×1 → `supervision.requested` → `supervision.skipped`（roster 无 supervisor）→ `supervision.completed`(escalate) → `supervision.user_review.requested`
   - 升级原因三条：roster 无 supervisor；`task_outcome:code-stack-evidence:blocked`；**自动修订预算耗尽**
   - `approval_requests` 表对此外**零行** → 从来没有可点卡片
   - **判断：Core 的行为是正确的**（`EnforceTaskOutcomeFacts` + `EnforceRevisionBudget` 各司其职；跳过模型审查不等于通过，代码化事实检查仍须执行）。缺陷纯粹在「送达不到人 + 送达了无法回答」。本轮已修前端送达链路。
2. **escalate 路径不产答案**：`FinalizeAsync` 只在 pass/skipped 时产答案，escalate 时 `checkpoint.MeetingResponse = null`。所以升级的 run 永远没正文——用户看到「一直在起草」其实是 run 已停。**这一点是否需要改 Core 语义，需要用户决定。**
3. **流式感知真相（量化过，5 个已完成 run）**：`run开始 → answer.started` 占整个 run 的 **69%–86%**（12.7–74.1s），而答案窗口只有 3.7–18.9s。这段长静默才是「没有流式」的真感受。
4. **已否决的方案**：500ms 落盘聚合——实测 5 个 run 合计只有 26 个 `answer.delta` 帧，省不了什么，不值得。
5. **已验证安全**：删除 `kind="delta"` 无害（5/5 个 run 的累积 `answer.delta` 等于 `messages.content`）。

---

## 四、必须注意的坑（血泪，请勿重踩）

### 4.1 绝对不要杀这些进程（用户正在用的实例）

| 进程 | PID | 端口 |
|---|---|---|
| Core `TinadecCore.Api` | **46128** | 48731 |
| Gateway bun | **49668** | 48730 |
| Vite | **49064** | 5173 |
| Electron main | **23728** | — |
| Electron renderers | 48200 / 41056 | — |
| Electron gpu/utility | 40136 / 44540 | — |

识别方法：命令行里带 `--user-data-dir="C:\Users\lincu\.tinadec\state\desktop"` 的是**用户的**；带 `e2e-home` / `tmp\e` 的是**测试的**。
另有 dotnet PID 18248/43508/48216/16968/45508/43892/10312/46040、TinadecTools 13284/44908 —— 都不要动。

### 4.2 环境与工具坑

- **不要用裸 `dotnet`**，用 `node scripts/dotnet.mjs`；构建加 `/m:1 --artifacts-path .tinadec_dev/tmp/<你自己的名字>` 避免锁 file。
- `run_code` 有 **~120s 硬上限**。长编译/长等待必须用 `tools.pwsh({run_in_background:true})` + `job_output`。
- `Get-ChildItem -Recurse` 扫大目录会超时。
- **Electron 必须在 `apps/desktop` 目录下启动**，并且要 `Remove-Item Env:ELECTRON_RUN_AS_NODE`（否则 electron.exe 退化成纯 Node，主进程在 `protocol.registerSchemesAsPrivileged` 崩，窗口永不出现）。
- **`TINADEC_HOST_CONTROL_TOKEN` 必须匹配 `^[A-Za-z0-9_-]{43,256}$`**，否则 `hostControl.cjs:6` 抛 `The trusted startup host credential is invalid.`。40 字符的还不够，要 ≥43。生成：32 随机字节 → base64url → 去 `=`（正好 43）。
- `TINADEC_HOME` 决定数据根目录；`TINADEC_GATEWAY_PORT` / `TINADEC_CORE_URL` / `TINADEC_GATEWAY_URL` 决定连接目标。
- **启动脚本要 `Remove-Item` 旧日志**，否则看到的是上一次的僵尸日志（我曾被误导，以为 token 无效，其实是端口被旧进程占着 + 日志是旧的）。
- 直连 Core/Gateway 的 REST 需要 host token，否则 403 `host_authorization_required`。这是**正常的**保护，不是 bug。
- `read_browser` 不可用（「Only Bots on the team have a browser」）；仓库**没有** CDP `remote-debugging-port` 配置，要自己加 `--remote-debugging-port=<port>`。
- 仓库**没有** mock 库（无 moq 等），C# 测试要用真实 DI。
- `node:sqlite` 可用（`import { DatabaseSync } from 'node:sqlite'`），PATH 里**没有** sqlite3 CLI。
- DB schema 易错点：`run_stream` 列名是 `sequence`（不是 `seq`）；**没有** `run_tasks` 表；`messages` 用 `content_reference`/`content_hash`/`content_length`；`run_stream.delta_length` 是 **UTF-8 字节数**不是字符数（中文约 3 字节/字）。

### 4.3 代码工具坑

- `tools.edit` 前**必须先 `tools.read`**（仓库 fs-observation-policy）。
- `run_code` 里嵌 C#/CSS/JS 时，**反引号模板字符串极易撞车**（报 `Expected a semicolon` / `Unterminated template`）。**解决：用字符串数组 + `.join("\n")`，避免反引号。**
- `pwsh` 里 `$HOME` 是只读自动变量，别拿来当普通变量名。
- `.mjs` 里不能用 `require`（`require is not defined in ES module scope`）。

### 4.4 测试坑

- `message-scroller.test.ts > opens at the end and follows new rows...` **是既存 flake，不是回归**。已用 `git stash` 后的干净树连续跑 3 次证明：pass/fail/pass，且失败断言会漂移。
- `SubAgents.test.ts` 的 fixture 用 `awaiting_user` 状态。把 `TurnWork` 的 `live` 直接改成 `working` 会让折叠默认收起 → 子智能体卡片找不到。**这就是为什么要拆成 `working` + `openByDefault` 两个 prop。**
- 工作树里有个 stash 叫 `user-wip-pre-debug`，**不是我的，绝对不要动**。

---

## 五、文档与证据位置

- 根因分析：`.tinadec_dev/evidence/2026-10-18-supervision-gate/rootcause.zh-CN.md`
- 平面模式状态设计：`.tinadec_dev/evidence/2026-10-18-flat-flow-status/{design.zh-CN.md,README.zh-CN.md}`
- 流式相关：`.tinadec_dev/evidence/2026-10-18-streaming-{core,lead,renderer}/`
- 模块说明：`apps/desktop/AGENTS.md` 顶部新增「2026-10-18 平面模式：状态进对话流，表头只剩标题」一节（含 deleted 清单与 verification）
- 临时探针脚本（可删）：`.tinadec_dev/tmp/{watch,run-detail,sup-payload,schema,schema2,watch-live,probe-api,cdp-*}.mjs`

---

## 六、一句话状态

**平面模式的表头/重复模块清理、监督裁决送达、真实 Electron 发消息、阶段步骤图标与 Vite 冷启动均已收口。**
**后续验证：`vue-tsc` 通过；SSE/监督/阶段/i18n 定向 34/34；真实 Electron 监督卡可答；两条真实模型消息 completed 并落盘；`vite build` 成功。边界仍是非 Windows、安装包和打包态未复验。**
