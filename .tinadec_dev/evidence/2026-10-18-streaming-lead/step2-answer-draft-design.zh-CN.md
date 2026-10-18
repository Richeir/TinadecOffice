# 步骤 2 设计：答案落地统一路径（替代 delta 冗余）

**日期：** 2026-10-18
**前置：** 步骤 1（补 streamAnswer）已完成并验证。

---

## 我在动手前发现的问题

我原本计划「直接删掉 `delta` 全文写入」，因为它在库里造成 100% 重复。
**但动手前的前置检查推翻了这个计划。**

`checkpoint.MeetingResponse` 有 **4 条产生路径**，只有 1 条带流式：

| # | 路径 | 位置 | 有 answer.delta 吗 |
|---|---|---|---|
| 1 | 正常 meeting 模型输出 | `:4840 GenerateMeetingResponseAsync` | ✅ 有（streamAnswer: true） |
| 2 | 模型不可用兜底 | `:4844 BuildMeetingEvidenceFallback` | ❌ 无 |
| 3 | 响应不可用兜底 | `:4858 BuildMeetingEvidenceFallback` | ❌ 无 |
| 4 | status_query | `:4616 BuildStatusResponseAsync` | ❌ 无 |

**所以 `delta`（全文）不是纯冗余——它给路径 2/3/4 兜底显示。**
直接删掉会让这 3 条路径的答案在界面上永远不出现。

---

## 两个方案

### 方案 A（补丁式，我否决）

在 `:4931` 加一个布尔：流式过就跳过 delta，没流式过就写。

```csharp
if (!checkpoint.AnswerStreamed)
    await AppendRunStreamAsync(..., "delta", meetingResponse, ...);
```

**否决理由**：这仍然是「两个 delta 语义 + 一个开关」，只是把冗余变成条件冗余。
`projectRunReply` 的 `provisional` 状态机还得留着。用户说「不该有的地方就重构」，这就是不该留的。

### 方案 B（彻底重构，我推荐）

**引入 `AnswerDraft`：答案的唯一累积器，流式与兜底都写它，终态统一落地。**

```csharp
/// 一次 run 的可见答案草稿。流式增量与最终全文走同一个对象，
/// 因此不存在「两份答案」的问题。
internal sealed class AnswerDraft
{
    private readonly StringBuilder _text = new();

    /// 流式增量到达（streamAnswer 路径）
    public void Append(string delta) => _text.Append(delta);

    /// 非流式路径直接设定全文（fallback / status_query）
    public void Set(string full) { _text.Clear(); _text.Append(full); }

    public string Text => _text.ToString();
    public bool IsEmpty => _text.Length == 0;
}
```

落地规则（`FinalizeAsync`）：

```
答案只经由 AnswerDraft 产生 → run_stream 的 answer.delta 由 Append 驱动
非流式路径调用 Set() → 若此前没有任何 answer.delta，补发一条 answer.delta 全文
终态 done 帧照旧
不再存在 kind="delta"
```

**收益**：
- 库里只存一份答案（`messages`）+ 一份流式预览（`answer.delta`），不再有第三份
- 非流式路径仍然能显示（通过补发一条 answer.delta）
- 前端删掉 `provisional` 状态机，`runReply.ts` 从 12 行降到 4 行
- 语义统一：**answer.delta 是答案的唯一流式表示，无论是逐帧还是单帧全文**

---

## 但方案 B 也有一个我必须说清的取舍

`AnswerDraft` 需要跨方法传递。当前 `checkpoint.MeetingResponse` 是持久化字段，
而 `AnswerDraft` 是内存态。两种做法：

1. **放进 checkpoint**（需要 schema 变更）—— 我倾向不做，checkpoint 是恢复语义，不该存草稿
2. **作为引擎实例字段，按 runId 索引**（内存 map，终态清理）—— 我倾向这个

第 2 种的风险：进程崩溃时草稿丢失，但 `messages` 里已有落地的答案，恢复语义不受影响。
（因为 `messages` 是在 Finalize 里写的，崩溃时要么都没写、要么都写了。）

---

## 我需要用户确认的点

方案 B 比方案 A 改动大：要新增类型、改 FinalizeAsync、改 4 条路径、改前端。
但它才是「彻底重构」。方案 A 快，但留下了一个我确定以后还会来咬人的开关。

**我倾向 B。** 如果用户确认，我就按 B 做。