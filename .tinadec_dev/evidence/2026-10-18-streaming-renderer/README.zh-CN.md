# 桌面端"流式输出完全没有"取证报告

- **日期**：2026-10-18
- **负责人**：stream-renderer（task-5）
- **范围**：桌面端渲染链路 + 设置页"支持流式"声明 + 真实运行数据实测
- **约束**：未修改任何生产代码，未提交 git，未停止用户正在运行的 Electron / Core / Vite 进程。
- **方法**：源码静态取证 + **真实项目库**（`C:/git/agent/RouterAPI/.tinadec/data/tinadec.db`，9.5 MB）`run_stream` / `model_invocations` / 事件 JSONL 实测 + 离线管线重放（vitest）。

> **一句话结论**：流式**确实实现了、也确实在工作**；问题在于**真正的回答正文只在整轮运行的最后 1–4% 的时间里流动**。一次 50 秒的运行里，答案文字的到达窗口只有 3.6 秒；一次 86 秒的运行里只有 0.3 秒。用户等了几十秒，看到的文字"唰"一下就完了——他说"完全没有流式"，是对**正文**的准确描述。而设置页那枚英文 `streaming` 徽章，是这个困惑的诱因。

> **方法学提醒（本轮踩过的坑，写下来防止后来者重复）**：`run_stream.delta_length` 列存的是 **UTF-8 字节数**，不是字符数（`LocalFileContentStore.PutAsync` 第 36 行 `length += read` 累加的是 `read` 字节）。中文文本下 489 字节 ≈ 215 字符，**相差 2.3 倍**。本报告初稿曾用字节数当字符数喂给平滑器，得出"817 字符 0.7 秒长完"的结论——那是错的。下文所有字符数均从 `content/` 实体文件按 UTF-16 长度重新量过。

---

## 一、用户说的"设置页显示它支持流式输出"到底在哪（优先级最高）

### 1.1 结论

**没有任何中文"流式输出"开关或设置项。** 用户看到的是**新增/编辑模型供应商弹窗里的「支持的能力」徽章区**，其中原样显示一个**硬编码的英文小写标签 `streaming`**。

用户真实库里 enabled 的 provider `382344D6-…`（display_name = `xxy`，2026-10-12 创建）**driver = `openai-compatible`**，因此该弹窗渲染的正是 `chat` `streaming` `tool-calls` 三枚英文徽章。

### 1.2 精确位置与原文

**渲染点**：`apps/desktop/src/pages/SettingsPage.vue:3925-3930`

```vue
<div v-if="currentTemplate" class="modal-capability-section">
  <div class="modal-form-section-title">{{ t('settings.supportedCapabilities') }}</div>
  <div class="model-capability-row">
    <span v-for="capability in currentTemplate.capabilities" :key="capability" class="provider-cap-tag">{{ capability }}</span>
  </div>
</div>
```

- 小节标题 `settings.supportedCapabilities` = **「支持的能力」**（`apps/desktop/src/locales/zh-CN.ts:1771`）。
- 徽章内容 `{{ capability }}` **直接插值，完全不过 i18n** —— 中文界面里就是英文字面 `streaming`。
- 样式 `apps/desktop/src/settings/settings.css:2378-2386`（`.provider-cap-tag`：11px、600 字重、圆角 6px、`--surface-raised` 底），视觉上是一枚"特性标签"。

**数据源**：`apps/desktop/src/pages/SettingsPage.vue:409`

```ts
const currentTemplate = computed(() => findTemplate(providerForm.driver))
```

`findTemplate`（`apps/desktop/src/providerTemplates.ts:614`）在**前端静态常量** `PROVIDER_TEMPLATES` 里按 driver 查表。含 `'streaming'` 的模板共 **17 处**：

| 行号 | 模板 | capabilities |
|---|---|---|
| 115 | openai-compatible ← **用户实际命中** | `['chat','streaming','tool-calls']` |
| 131 | anthropic | `['chat','streaming','reasoning','tool-calls']` |
| 147 | google | 同上 |
| 162 | deepseek | 同上 |
| 177 | openrouter | `['chat','streaming','routing','tool-calls']` |
| 192 | pollinations | `['chat','streaming','public-api','no-api-key']` |
| 207 | groq | `['chat','streaming','fast']` |
| 222 | togetherai | `['chat','streaming','tool-calls']` |
| 237 | fireworks | `['chat','streaming']` |
| 252 | xai | `['chat','streaming','tool-calls']` |
| 267 | mistral | 同上 |
| 282 | cohere | `['chat','streaming','tool-calls','rag']` |
| 297 | qwen | `['chat','streaming','reasoning','tool-calls']` |
| 312 | azure-openai | `['chat','streaming','tool-calls','enterprise']` |
| 327 | aws-bedrock | `['chat','streaming','enterprise']` |
| 342 | github-copilot | `['chat','streaming','tool-calls']` |
| 605 | custom | `['chat','streaming']` |

**另一处中文"流式"**：Kimi Code 模板摘要（`providerTemplates.ts:518` 引用 `providers.kimiCodeSummary`），`zh-CN.ts:1892`：

```
kimiCodeSummary: 'Moonshot Kimi Code 智能体，可走 ACP 会话或流式单次运行'
```

（zh-TW 同文在 `2300`，en `1894`。）渲染在弹窗摘要区（`SettingsPage.vue:3842`）。

**穷举核对**：`apps/desktop/src/locales/*.ts` 中含「流式/实时/逐字/打字机」的键只有：

- `kimiCodeSummary`（zh-CN 1892、zh-TW 2300）——唯一含"流式"二字的用户可见文案；
- `homeEventsDesc`(708)、`homeAgentDesc`(712)、`liveDiscovery`(1333)、`liveMode`(2294)、`liveActivity`(2343) 等——都是"实时"而非"流式"，分属事件页/模型发现/活动区，与聊天输出无关。

`SettingsPage.vue` 内**搜不到任何 `stream` 字样**；`src/settings/` 目录下同样为零。→ **不存在"流式输出"开关/说明文字。**

### 1.3 这个徽章实际承诺了什么（判定）

**它承诺的是"该供应商/传输通道具备流式能力"，不是"本应用聊天界面会逐字渲染回答"。** 依据：

1. **纯静态前端常量**，不来自 Core 运行时探测，不随实际状态变化。
2. **不驱动任何运行时行为**，只有两个消费点：
   - 渲染成徽章（上面 3928）；
   - 作为保存 payload 的默认值回写：`SettingsPage.vue:1868-1870`
     ```ts
     capabilities: providerForm.id
       ? selectedProvider.value?.capabilities ?? tmpl?.capabilities ?? []
       : tmpl?.capabilities ?? [],
     ```
     Core 把它当不透明字符串数组存进 provider 版本 JSON（`api.ts:424` `capabilities: string[]`），**没有任何 Core 代码读它来决定是否流式**。
   - 动态路径 `runtimeCenterView.ts:226-240`（`supplier.capabilities.supports_streaming`）只服务模型中心概览合成，不进聊天链路。
3. **真正的流式开关在 Core 内部且是硬编码的**：`streamAnswer: true` 全仓只有 **一个**调用点——`TinadecCore/DmaEA/FullDuplexRunEngine.cs:5349`（最终会议回答）。其余 11 处 `CreateModelFactory(...)`（形参声明 `3252`，生效判断 `3288`）都用默认 `streamAnswer = false`。**用户无法通过任何设置改变它。**

→ 准确说法：**这些徽章是关于供应商能力的静态元数据，用户把它读成了对本产品输出方式的产品承诺。** 界面没有明说"逐字显示"，但中文界面里混着一枚不该给终端用户看的英文实现细节标签，且它与用户真正关心的"输出会不会一段段长出来"无关。**这是产品文案缺陷，不是功能缺陷**；但也**不能**写成"声明是真的所以没问题"。

---

## 二、是否存在重复订阅 / 重复渲染同一个 run（已证实：**没有**）

1. **唯一订阅入口**：聊天链路里 `createRunStream` 全仓仅 `HomeController.ts:547` 一处（`api.ts:2853` 那处是 AI commit-message / 变更分析的一次性生成器，与聊天无关）。
2. **按 runId 幂等**：`HomeController.ts:538-544`
   ```ts
   function attachRun(runId: string) {
     if (!canAccessBackend.value) return
     const existing = runStreams.get(runId)
     if (existing) {
       if (existing.status.value === 'closed' || existing.status.value === 'error') existing.connect(existing.lastSeq.value)
       return
     }
   ```
   已有句柄时只可能按 `lastSeq` 续连，绝不新建第二条流。`runStreams` 是 `Map<string, RunStreamHandle>`（`106`）；`attachActiveRuns()`（`597-608`）逐 run 调 `attachRun`，整个循环天然幂等。
3. **传输层二次去重**：`runStream.ts:150-160` 用 `${run_id}:${seq}` 组 `seen` 集合丢弃重复帧。单测钉住：`HomeController.test.ts:813` *"resumes the same run cursor after host recovery without duplicating streamed text"*。

**结论**：文本不会因重复订阅而重复或互相覆盖。此条可划掉。

---

## 三、最终消息落地时是否"闪一下再整体替换"（已证实：**不是清空重填**）

### 3.1 `done` 分支做了什么

`HomeController.ts:574-585`：

```ts
if (chunk.kind === 'done' || chunk.kind === 'error') {
  provisionalReplies.delete(runId)
  ...
  void loadMessagesAndApprovals().catch(...)   // 全量重读
  runStreams.get(runId)?.disconnect()
  runStreams.delete(runId)
  syncWorking()
}
```

- **不清 `streamingText`**（清空只发生在会话切换 `1300`、脱流清理 `603`）。
- `readMessagesAndApprovals()`（`471-535`）把 `messages.value` 整体替换为服务端列表（`514`，保留 `pending-` 乐观项），随后 `attachActiveRuns()`（`533`）。

### 3.2 为什么没有"空白闪烁"：两道数据守卫（不是时序侥幸）

1. `HomeController.ts:824-828` 的 `streamingReplies` 只发布**非终态**且**尚无 assistant 消息**的 run：
   ```ts
   runs.value.filter(run => !['completed','failed','cancelled'].includes(run.status)
     && !messages.value.some(message => message.role === 'assistant' && message.run_id === run.id))
   ```
2. `ConversationTurn.vue:139` 的流式块本身带同一条件：
   ```vue
   <AssistantAnswer v-if="run.streamingText && !answers.some((answer) => answer.run_id === run.id)" :content="run.streamingText" streaming />
   ```

"有 assistant 消息"的那一刻，流式块与正式答案**原子互换**：同一份文本不会同时出现两次，也不会先变空。新 `AssistantAnswer` 首次挂载时 `streaming=false`，`useSmoothText.ts:27` 直接 `shown = target.value`（全文上屏）——**不闪白、不丢字**。

### 3.3 预览与权威全文逐字节相同（已证实，实测）

把每个 run 的 `answer.delta` 实体拼接，与最终 `delta` 实体对比（`probe14.cjs` / `probe10.cjs`）：

| run | 预览拼接(字符) | 最终 delta(字符) | 完全相同 |
|---|---|---|---|
| 1AD5BA8C | 207 | 207 | ✅ |
| 29A7F645 | 261 | 261 | ✅ |
| 6E36E2E4 | 337 | 337 | ✅ |
| 94FC4AD7 | 1474 | 1474 | ✅ |
| F3C56554 | 346 | 346 | ✅ |

→ 最终 `delta` 是把预览**原样替换成同一份文本**，不补内容、不产生视觉跳变。

### 3.4 一个真实但极窄的缺口（推断，未在真实 UI 复现）

`streamingReplies` 的过滤条件是"run 终态 **OR** 已有消息"。若某一渲染帧恰好落在"run 已 `done`"与"assistant 消息可读"之间，该 run 已终态被过滤、消息又还没到 → **这一帧没有正文**。Core 的顺序（`FullDuplexRunEngine.cs:4928-4967`）是 `delta`（全文）→ 追加 assistant 消息 → `PersistRunEvidenceAsync` → `CompleteTurnAsync` → `done`，理论上消息先于 `done` 落库。实测 `last delta → done` 间隔 1.0–11.8s ≫ 一次 HTTP 往返，**未观测到该路径被触发**。列为待观察，非本次成因。

---

## 四、`streamingText` 到 UI 的渲染路径（已证实：**逐 chunk、零额外合并**）

```
Core SSE 帧
 → runStream.ts dispatch（seq 去重后同步回调，无防抖）
 → HomeController.onChunk（564）  projectRunReply → runText / provisionalReplies
 → streamingText.value = new Map(...).set(runId, reply.text)   （571，每个 chunk 一次）
 → streamingReplies computed（824）→ ChatCard(51)/ChatPanel(149)
 → ConversationView.turns computed（45-53，buildTurns 传 streaming Map）
 → ConversationTurn.streamingText（turns.ts:108）
 → AssistantAnswer（streaming=true）
 → useSmoothText（28）→ MarkdownRender
```

**没有任何 rAF 批处理、setTimeout 合并或 debounce。** 每个 chunk 一次同步状态更新。`MarkdownRender.vue` 里只有锚点高亮/复制反馈两个与渲染节奏无关的 `setTimeout`。→ **渲染器侧不存在"额外合并削弱流式观感"的问题。**

### 4.1 平滑器 `useSmoothText` 的实际行为（实测，纠正初稿）

规则（`useSmoothText.ts:50-58`）：名义 90 字符/秒；当 `backlog / pace > catchUp(0.3s)`（即 backlog > 27 字符）时，把 pace 提为 `backlog / 0.3`，在 0.3 秒内追平。

用**真实时间线 + 真实字符数**重放（`reveal-curve.test.ts`，手动 16ms 帧时钟，4 test 全绿）：

| run | 总时长 | 正文前静默 | 正文窗口(首→末 delta) | 首字→全部可见(实测) | 平均揭示速率 | 最大滞后 |
|---|---|---|---|---|---|---|
| 1AD5BA8C | 27.5s | 82% | 4.1s | 4.18s | 50 c/s | 110 |
| 29A7F645 | 16.5s | 90% | 0.4s | 0.70s | 371 c/s | 130 |
| 6E36E2E4 | 85.8s | 90% | 0.3s | 0.48s | 708 c/s | 215 |
| 94FC4AD7 | 49.6s | 90% | 3.6s | 3.90s | 378 c/s | 187 |
| F3C56554 | 81.7s | 85% | 0.9s | 1.20s | 287 c/s | 256 |

**关键结论（与初稿相反）**：

- **多 chunk 运行里平滑器几乎是透明的**。`94FC4AD7` 有 15 个 chunk、平均 245ms 到达一个；平滑器揭示耗时 **3.90s vs 到达跨度 3.60s**，只多了 0.3s 的追赶窗口。它忠实地按到达速度揭示，**没有把过程压平**。
- **少 chunk 运行里平滑器确实会快进**。`6E36E2E4` 只有 2 个 chunk（215 / 122 字符），揭示耗时 0.48s，≈708 c/s。但这是因为**chunk 本身就很大**（模型一次吐 215 字符），平滑器只能吃掉 0.3s 的追赶窗口，剩下仍是瞬时。
- 即：**平滑器不是瓶颈，chunk 尺寸和到达时机才是。**

---

## 五、实测：真实运行到底发生了什么（已证实）

数据源：`run_stream`（chunk 时序）+ `content/` 实体（字符数）+ `model_invocations`（供应商调用窗口）+ `data/events/*.events.jsonl`（`model.output.*` 通道级事件）。

### 5.1 逐 run 的阶段分解（时间基准 = 该 run 的 `ack`）

| run | 总时长 | A: ack→answer.started | B: started→首字 | C: 正文流动 | D: 末字→done | 正文流动占比 |
|---|---|---|---|---|---|---|
| 29A7F645 | 16.5s | 12.7s | 2.0s | **0.4s** | 1.2s | **2.4%** |
| 1AD5BA8C | 27.5s | 19.1s | 3.4s | **4.1s** | 1.0s | **15%** |
| 94FC4AD7 | 49.6s | 36.3s | 8.1s | **3.6s** | 1.6s | **7.3%** |
| F3C56554 | 81.7s | 62.8s | 6.2s | **0.9s** | 11.8s | **1.1%** |
| 6E36E2E4 | 85.8s | 74.1s | 3.3s | **0.3s** | 8.1s | **0.4%** |

**这就是用户"完全没有流式"的量化解释**：正文真正在流动的时间只占整轮的 **0.4%–15%**，中位数约 2–7%。其余 85–99% 的时间里，聊天正文区是空的。

### 5.2 为什么 A、B 两段那么长（已定位到具体机制，不是"Core 慢"）

**A 段（12.7–74.1s）= 多轮工具调用的 worker 工作**。以 `94FC4AD7` 为例，`model_invocations` 记录了三轮供应商调用：

```
 4.1s → 10.3s  (6.3s,  897 tok)   worker 规划
18.4s → 33.7s (15.3s, 2840 tok)   worker 执行（含 2 次工具调用）
36.1s → 48.4s (12.3s, 1890 tok)   ← 最终会议回答（streamAnswer: true）
```

`answer.started` 出现在 36.3s，正是第三轮（最终回答）调用的开始。

**B 段（2.0–8.1s）= 最终回答调用里的"推理通道"阶段**。事件 JSONL 显示 `94FC4AD7` 的第三轮调用在 36.35s→48.32s 之间产出：

- `reasoning` 通道 **12 430 字符**，从 36.35s 直到 44.10s；
- `text` 通道 **0 字符**（不写事件日志，见下）；
- 正文由 `answer.delta` 承载，44.4s→48.0s。

也就是说：**模型先"想"了 8 秒，然后才在最后几秒把答案写出来。** 这不是 Core 延迟，是模型的自回归生成顺序（推理 token 在前，答案 token 在后）。

> 事件日志里 `text` 通道为 0 字符是**设计如此**，不是缺陷：`FullDuplexRunEngine.cs:3276-3286` 只在 `frame.Channel == "reasoning"` 或 `task is not null` 时写 `model.output.delta`，代码注释明确写着 *"The conversation's own answer streams on the run stream instead"* —— 答案正文走 run stream 的 `answer.delta`，不重复进事件日志。

**关键**：这 8 秒推理**是可见的**——`model.output.delta`（channel=reasoning）经 reducer（`reducer.ts:403-443`）进入 `ReasoningEntry`，由 `ReasoningBlock.vue` 渲染，`useAutoDisclosure(thinking)` 在 `status === 'running'` 时**默认展开**。用户在这段时间看到的是"思考过程"在流式增长，**不是完全空白**。

### 5.3 C 段：Core 的分段粒度其实是合格的

`ModelOutputStream.cs:45` 的合并规则是 `pending.Length >= 256 || 距上次 flush >= 100ms`。实测 `94FC4AD7` 的 15 个 chunk 平均 **98 字符**（范围 2–178），间隔约 245ms——**远未触及 256 字符阈值，全部由 100ms 定时器触发**。即 Core 已经以 ~100ms/次的粒度转发，与模型自身吐字速度一致。

→ **Core 的合并粒度不是本次的原因**（初稿曾怀疑 256 字符阈值太粗，实测证伪）。

### 5.4 单次回答的平均粒度

5 次运行共 26 段 `answer.delta`，正文合计 **2625 字符** → 平均每段约 101 字符。分布极不均匀：`6E36E2E4` 仅 2 段（215 + 122 字符），`94FC4AD7` 15 段（2–178 字符）。

### 5.5 那些"零 delta"的运行（全库 19 条 run 的完整对账）

把 `runs` 全表与 `run_stream` 交叉核对，结果是一个**完美相关**：

| runs.status | 条数 | 有 `answer.delta` | 无 `answer.delta` |
|---|---|---|---|
| completed | **5** | **5** | 0 |
| cancelled | 6 | 0 | 6 |
| failed | 7 | 0 | 7 |
| awaiting_user | 1 | 0 | 1 |
| **合计** | **19** | **5** | **14** |

- **5/5 completed 运行全部发出过 `answer.delta`，无一例外。**
- 14 条无 delta 的运行**全部不是 completed**：6 条 cancelled（用户中止，含跑了 998.7s 的 `1EC15446`）、7 条 failed、1 条 `awaiting_user`（`D7615B3B`，卡在人工审批）。

→ **不存在"已完成的运行却完全没有流式"。状态与是否流式正文呈 1:1 对应，流式链路是通的。** 零 delta 全部可归因于运行没有走到"最终回答"这一步。

---

## 六、定性：用户为什么说"完全没有"

### 6.1 已证实的事实链

1. 用户配置的 `openai-compatible` 供应商弹窗显示 `chat` / `streaming` / `tool-calls` 三枚英文徽章（第一节）。
2. SSE 链路通、渲染链路通、无重复订阅、无破坏性闪替、无渲染器额外合并（二、三、四节）。
3. 正文 chunk 以 ~100ms 粒度、按模型自身吐字速度到达；Core 合并粒度合格（5.3）。
4. **正文流动窗口只占整轮的 0.4%–15%**（5.1）。
5. 正文窗口之前的 80–99% 时间用于：多轮工具调用（A 段）+ 最终调用的推理阶段（B 段）。
6. 最终权威 `delta` 与预览逐字节相同，替换不可感知（3.3）。

### 6.2 推断（明确标注为推断）

用户的观感是这些因素叠加的结果，**不是某个开关没开、也不是渲染器坏了**：

- **他们要看的"回答"，在最后几秒才存在**。模型先推理后作答，答案 token 天然排在推理 token 之后；推理 12 430 字符 vs 正文 1474 字符（`94FC4AD7`），正文只占输出量的 10%。
- **正文窗口太短，短到无法形成"逐字生长"的印象**。2.4%（`29A7F645`，0.4s 内 261 字符）和 0.4%（`6E36E2E4`，0.3s 内 337 字符）在主观上与"一次性出现"**完全无法区分**。
- **思考区在流，但用户不把它算作"输出"**。用户说"完全没有"时，指的是**回答正文区**。思考折叠区确实在动，但那是"agent 在忙"，不是"它在给我写答案"。
- **短回答必然像一次性**：回答越短（`6E36E2E4` 337 字符），chunk 数越少（2 个），窗口越短（0.3s）。
- **零 delta 的取消运行**（6/11）会强化"这东西从来不流式"的印象——取消前那段漫长等待里，答案区确实一个字都没有。

---

## 七、可核查的复现/度量装置（未改生产代码）

- `.tinadec_dev/tmp/stream-renderer/vitest.config.ts` — 独立 vitest 配置，alias `@` → `apps/desktop/src`，复用仓库根 `node_modules`，**不需要**跑全量测试。
- `render-path.test.ts` — 用 `ReadableStream` 手推 SSE 帧，验证 `createRunStream` + `projectRunReply` 在 `done` 之前就发布文本、不丢不重（3 test 全绿）。
- `reveal-curve.test.ts` — 真实 chunk 时间线 + 真实字符数 + `useSmoothText` 真实实现 + 手动帧时钟；断言"正文前静默 ≥80%"（4 test 全绿）。
- `measure-run-stream.cjs` — **本目录内**，直读真实 `tinadec.db` 的 `run_stream`，为全部 19 条 run 输出阶段分解；结果已存为 `run-stream-measurements.json`。这是复现第五节的入口（只读，`readOnly: true`）。
- `.tinadec_dev/tmp/stream-renderer/probe*.cjs` — 一次性探针，直读 `content/` 实体、`model_invocations`、事件 JSONL，产出 5.2 / 5.3 的表。

```bash
node .tinadec_dev/evidence/2026-10-18-streaming-renderer/measure-run-stream.cjs
```

跑法：

```bash
cd .tinadec_dev/tmp/stream-renderer && ../../../node_modules/.bin/vitest run
```

### 度量局限（诚实边界）

- 真实库里的运行是 **2026-10-13 / 10-16 / 10-17** 的，不是用户抱怨当下那一次；只能证明"这套系统在真实使用中的节奏确实如此"，不能证明用户那一刻的逐帧画面。
- 全部 19 条 run 里只有 5 条 completed，且都集中在 10-13 / 10-17；样本量小，"典型节奏"的判断基于这 5 条，不外推到所有模型/供应商。
- 5.2 节的 reasoning/text 通道统计来自事件 JSONL 的 `channel` 字段；`text` 通道按设计不写事件日志（`FullDuplexRunEngine.cs:3276-3286`），因此"text=0"不代表模型没输出文本，只代表正文走了另一条通道。
- **没有 DevTools 实测**：本机 Electron 未开 CDP 端口（9222 不可达），无法抓真实渲染帧时序。4.1 节的曲线是**用真实时间线重放真实实现**得到的，属"等价复现"而非"现场录制"。
- 未测量 Gateway 在慢客户端下是否进一步缓冲 SSE（本次所有测量基于落库时序，链路耗时未单独分离）。
- 未测量用户当时的具体 provider 速率；`model_invocations` 里的 6.1–21.2s 单次调用时长含真实网络往返。

---

## 八、如果要修，方向在哪（仅建议，本次未改代码）

按证据排序，**前两条才是关键，且都不在渲染器**：

1. **让"答案正在生成"在正文区可见**（收益最大）。当前 `answer.started` 到首字有 2.0–8.1s，这段时间正文区完全空白。可以：
   - 在正文区显示占位骨架/打字指示（"正在作答…"），把这 2–8 秒的空白变成可感知的等待；
   - 或把最终调用的 reasoning 通道摘要（`ReasoningBlock` 已有实时能力）在正文区做一个轻量提示。
2. **缩短 A 段（12.7–74.1s）**。这是多轮工具调用的真实工作量，不是 bug；但用户在这期间只看到活动折叠区。**若要在产品上改善"流式感"，这是唯一有数量级收益的地方**——例如让 worker 的中间结论以简短流式文本呈现，而不是全部折叠进活动区。
3. **不要动 `useSmoothText` 的算法**。实测它在多 chunk 场景下只增加 0.3s 滞后、几乎透明（4.1）；改它不会改善观感，反而可能引入"回退"感。
4. **不要把 Core 的 256 字符阈值当成主因去调小**。实测 15 个 chunk 平均 98 字符、全部由 100ms 定时器触发，**没有触及 256 阈值**（5.3）。把它调小无收益，只会增加 DB 写入。
5. **把设置页那枚英文 `streaming` 徽章从用户可见面移走或本地化**（低成本、直接消除误导）。它是实现细节，被用户读成产品承诺——纯文案缺陷。

**不要做**：改 `streamingReplies` / `ConversationTurn` 的显隐条件。第三节的守卫逻辑是对的，改了会造成重复渲染或空白帧。

---

## 九、逐问速答（对 task-5 五个问题的收敛）

| # | 问题 | 结论 | 性质 |
|---|---|---|---|
| 1 | 设置页哪里显示"支持流式" | `SettingsPage.vue:3925-3930` 的「支持的能力」徽章，渲染 `providerTemplates.ts` 静态常量里的英文 `streaming`（用户 driver=`openai-compatible` → 第 `115` 行，显示 `chat/streaming/tool-calls`）；另有 `zh-CN.ts:1892` Kimi 摘要含"流式单次运行"。**无中文"流式输出"开关** | 已证实 |
| 2 | 是否重复订阅/重复渲染同一 run | 否。唯一订阅点 `HomeController.ts:547`，`attachRun` 幂等守卫 `540-544`，`runStream.ts:150-160` 按 `run_id:seq` 去重 | 已证实 |
| 3 | 最终消息落地是否闪替 | 否。`done` 不清 `streamingText`；`streamingReplies`(824-828) 与 `ConversationTurn.vue:139` 双重守卫保证原子互换；预览与权威全文逐字节相同 | 已证实；极窄缺口为推断 |
| 4 | `streamingText` 的渲染路径与节流 | 逐 chunk 同步更新，**渲染器零额外合并**；`useSmoothText` 在多 chunk 场景几乎透明（+0.3s），少 chunk 场景会快进（0.48s / 337 字符） | 已证实 |
| 5 | 实测 | 真实库 5 条 completed 运行：正文流动仅占整轮 **0.4%–15%**；6 条零 delta 运行全部是 cancelled；正文前静默期由多轮工具调用 + 最终调用的推理阶段构成 | 已证实 |

---

## 十、一句话总结

**流式实现了、链路通了、渲染器忠实且即时、平滑器也不是瓶颈——但答案正文只在整轮运行的最后 1–4% 时间里流动（0.3–4.1 秒），此前的 85–99% 时间用于多轮工具调用和模型推理，正文区是空的。** 用户在几十秒的等待后看到文字"唰"一下出现，说"完全没有流式"，对正文而言是准确的。设置页那枚英文 `streaming` 徽章让这个问题从"可以理解的生成节奏"变成了"产品承诺没兑现"。**要改善必须在 Core 的产出节奏与正文区的等待反馈上动手，改渲染器无效。**