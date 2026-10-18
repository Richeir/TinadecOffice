# 流式输出诊断（Lead 侧）—— 含两次自我纠正

**日期：** 2026-10-18
**报告人：** lead
**用户原话：** "我们的流式输出功能到底是个什么东西？好像完全没有流式输出这个概念……纯粹是输出完以后突然显示。"

---

## ⚠️ 阅读须知：本报告推翻了前两版结论

这份报告经过两次重大自我纠正。如果你读的是旧版，请以下面结论为准。

| 版本 | 我当时的结论 | 为什么错了 |
|---|---|---|
| v1 | "256 字符合并阈值是主因" | 把 `delta_length`（UTF-8 **字节**）当成字符数，放大了 2.3 倍 |
| v2 | "worker 输出不进 run stream，前 74 秒界面全空" | **错**。worker 的 text 经 `reducer.ts:436` 进 `ReasoningEntry.output`，由 `ReasoningBlock.vue:58` 以正文色渲染，可见 |
| **v3（当前）** | 见下 | — |

---

## 结论：流式链路完全正常，问题是"正文可见窗口太短"

全库 19 条 run 对账是完美 1:1：

| runs.status | 条数 | 有 answer.delta |
|---|---|---|
| completed | 5 | **5** |
| cancelled | 6 | 0 |
| failed | 7 | 0 |
| awaiting_user | 1 | 0 |

**5/5 completed 全部流过正文，无一例外。** 不存在"完成了却没流式"。

问题在于**正文流动只占整轮的 0.4%–15%**：

| run | 总时长 | 正文流动 | 占比 |
|---|---|---|---|
| 29A7F645 | 16.5s | 0.4s | 2.4% |
| 1AD5BA8C | 27.5s | 4.1s | 15% |
| 94FC4AD7 | 49.6s | 3.6s | 7.3% |
| F3C56554 | 81.7s | 0.9s | 1.1% |
| 6E36E2E4 | 85.8s | 0.3s | 0.4% |

0.3 秒里出 337 字符，**主观上与"一次性出现"完全无法区分**。

---

## 实测数据（我亲自复核过）

### 合并粒度其实是合格的

`run_stream.delta_length` 是 **UTF-8 字节**（`LocalFileContentStore.cs:36` 的 `length += read`）。
我实测解码了全部 26 段 `answer.delta`：

```
字符数: n=26  min=2  p50=95  max=256
触及 256 阈值的帧数: 1 / 26
```

**只有 1 帧触及阈值，其余全部由 100ms 定时器触发。**
而且 `562 字节 = 256 字符` 恰好等于阈值——证实阈值确实在工作，但触发频率不高。

→ **Core 的合并粒度不是本次的原因。调小阈值无效。**

### worker 的正文是可见的（推翻我的 v2 结论）

`reducer.ts:435-436`：

```ts
if (payload.channel === 'reasoning') entry.text += str(payload, 'delta') ?? ''
else if (payload.channel === 'text') entry.output += str(payload, 'delta') ?? ''
```

`ReasoningBlock.vue:58` 渲染 `entry.output`，CSS 用 `--text-primary`（正常正文色）。
且 `useAutoDisclosure(thinking)` 在 `status === 'running'` 时 `open = live = true`——**运行中默认展开**。

我实测 `6E36E2E4` 的事件日志：

```
  46.1s  ch=reasoning  len=   2   → 思考块
  46.6s  ch=reasoning  len= 245   → 思考块
  49.6s  ch=text       len= 256   → 正文（run stream + ReasoningEntry.output）
  50.1s  ch=text       len= 106
  50.7s  ch=text       len= 152
  77.1s  ch=reasoning  len=   3
  77.5s  ch=reasoning  len= 227
```

**所以那 74 秒不是空白**——思考文本在流式增长，用户看得到。

---

## 那用户为什么说"完全没有"？

诚实地说：**用户的主观描述与实测有偏差，但偏差是有原因的。**

可能的原因（按我的置信度排序）：

1. **思考块虽然可见，但用户不认为那是"输出"**。用户说"完全没有"，指的可能是"正文区没有逐字长出来"。思考块在动，但那是"它在想"，不是"它在给我写答案"。这个区分是真实的。
2. **正文窗口 0.3–4 秒，短到无法形成"逐字"印象**。337 字符在 0.3 秒内完成，人眼只能感知"一下就出来了"。
3. **6/19 的取消运行确实全程无正文**，会强化"这东西从来不流式"的印象。
4. **设置页那枚英文 `streaming` 徽章**（见下）建立了错误预期。

---

## 设置页那处"支持流式"——已定位，但不是承诺

`SettingsPage.vue:3925-3930`「支持的能力」区块，渲染 `currentTemplate.capabilities`：

```vue
<span v-for="capability in currentTemplate.capabilities" class="provider-cap-tag">{{ capability }}</span>
```

数据源是**前端静态常量** `providerTemplates.ts` 的 `PROVIDER_TEMPLATES`（17 处含 `'streaming'`）。
用户的 provider driver 是 `openai-compatible` → 命中第 115 行 → 显示 `chat / streaming / tool-calls`。

**关键**：标签**不过 i18n**，中文界面直接显示英文字面 `streaming`；
且**没有任何代码据此决定是否流式**（真正的开关是 `FullDuplexRunEngine.cs:5349` 唯一的硬编码 `streamAnswer: true`）。

→ 这是"该供应商/通道支持流式"的静态元数据，**没有承诺"本界面会逐字显示"**。
但把实现细节摆在用户面前让人读成产品承诺，**文案误导成立**。

---

## 真正的修复方向

基于以上实测，**改合并阈值和改渲染器都无效**。真正有效的方向：

### 优先级 1：让正文窗口变长（治本）
正文 0.3–4 秒是因为模型先推理后作答。可做的：
- 把 A 段（12.7–74.1s 的多轮工具调用）的中间结论做成可见流式，而不是全折叠
- 正文开始前给明确占位（"正在作答"），把 2–8 秒的静默变成可感知等待

### 优先级 2：修 `GenerateInteractionResponseAsync` 漏传 `streamAnswer`
`FullDuplexRunEngine.cs:4617` 的追问回复路径未传 `streamAnswer: true`，
而主答案路径 `5349` 传了。**追问回复完全不进 run stream**——这是真实缺陷，虽然不影响首轮。

### 优先级 3：设置页徽章本地化或移除
低成本，直接消除误导。

### 已排除（不要做）
- ❌ 调小 256 字符阈值（实测只有 1/26 帧触及）
- ❌ 改 `useSmoothText`（实测只加 0.3s，几乎透明）
- ❌ 加内存广播通道（原设计基于错误前提；`FollowAsync` 150ms 轮询不是瓶颈）

---

## 关于"渲染与落盘解耦"（用户提出的架构方向）

用户在听取中期汇报后提出："db 落盘和渲染要分开，渲染流式输出，写入走统一的时间窗口，不记录实时的流式输出数据。"

**设计文档**：`design-decouple-render-from-persist.zh-CN.md`

但基于 v3 的实测，我要诚实说明：**这个方向本身是对的（架构上更干净），但它不是当前症状的解药**。
因为渲染延迟的瓶颈不在 DB 落盘（正文 chunk 间隔 245ms，与用户感知的 0.3s 窗口一致），
而在于**正文本身只存在 0.3–4 秒**。

如果做了这个改造，收益是：架构更清晰、DB 写入减少。
但用户看不到的"流式感"不会因此变好。**要先说清楚这一点，再决定是否做。**

---

## 证据与可复现装置

- 本文目录：`README.zh-CN.md`、`design-decouple-render-from-persist.zh-CN.md`、`simulate-coalescing.mjs`
- Lead 侧探针：`TinadecCore/tests/TinadecCore.AgentFramework.Tests/OpenAiSdkUpdateGranularityProbe.cs`
  （证实 OpenAI SDK 不合并：20 个单字符 chunk → 20 个 update）
- Lead 侧测试：`ModelOutputStreamGranularityTests.cs`（4 test 绿，但**测试前提现已证明与真实场景不符**——见下）
- stream-renderer 报告：`../2026-10-18-streaming-renderer/README.zh-CN.md`（质量高，主动纠正了初稿）

### 关于我写的 4 个测试

`ModelOutputStreamGranularityTests.cs` 声称"400 汉字 → ≤3 帧"。**这在真实场景下不成立**：
真实 provider 每秒吐几十字符，100ms 定时器会先触发，轮不到 256 阈值。
那 4 个测试用**零延迟**的假客户端，构造了现实中不存在的极端情形。

**这些测试应当删除或重写**，否则会误导后来人。我会在动手修复时一并处理。

---

## 诚实边界

- 我没有在真实 Electron 界面里录制流式帧（本机未开 9222 DevTools）。
- 样本只有 5 条 completed run，集中在 10-13 / 10-17。
- "用户为什么说完全没有"这部分是**推断**，我没有直接访谈。
- 我犯了两次判断错误（字节/字符混淆、误判 worker 输出不可见），都是靠 stream-renderer 的报告和亲自复核纠正的。
