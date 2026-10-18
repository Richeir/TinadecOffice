# 步骤 2 完成报告：答案落地统一路径

**日期：** 2026-10-18
**状态：** ✅ 完成并验证

---

## 做了什么

### 1. 新增 `AnswerDraft`（`TinadecCore/DmaEA/AnswerDraft.cs`）

答案的唯一累积器。流式走 `Append`，非流式路径走 `SetWhole`，终态由 `FinalizeAsync` 统一发布。

### 2. 引擎接入（`FullDuplexRunEngine.cs`，+36/-7）

| 位置 | 改动 |
|---|---|
| `:164` | `ConcurrentDictionary<Guid, AnswerDraft> _answerDrafts` |
| `:3290` | publish 回调里 `streamAnswer` 时累积草稿、标记已发布 |
| `:4944` | 删掉 `kind="delta"` 全文写入；改为草稿兜底，按 `answer.delta` 发布 |
| `:4652` | 步骤 1 的 `streamAnswer: true`（保留） |

### 3. 前端简化

| 文件 | 改动 |
|---|---|
| `runReply.ts` | 12 行含 `provisional` 状态机 → **8 行纯累加** |
| `runReply.test.ts` | 重写为 4 个测试，覆盖累加/重试重置/忽略非增量/兜底全文 |
| `HomeController.ts` | 删除 `provisionalReplies` 集合及 4 处引用 |
| `HomeController.test.ts` | chunk kind `'delta'` → `'answer.delta'` |

---

## 验证结果

| 检查 | 结果 |
|---|---|
| `TinadecCore.DmaEA` 编译 | ✅ 成功 |
| `TinadecCore.Api` 全量编译 | ✅ 成功 |
| `Dmaea` 后端测试 | ✅ **8/8 通过** |
| `runReply.test.ts` | ✅ **4/4 通过** |
| `vue-tsc --noEmit` | ✅ 无错误 |
| Desktop 全量 | 1373 通过 / 1 失败（**既有失败**，见下） |

### 关键数据验证：删掉 `delta` 是否安全

用真实项目库逐字节比对 5 个 completed run：

| run | answer.delta 累积 | messages.content | |
|---|---|---|---|
| 1AD5BA8C | 207 ch | 207 ch | ✅ EQUAL |
| 29A7F645 | 261 ch | 261 ch | ✅ EQUAL |
| 6E36E2E4 | 337 ch | 337 ch | ✅ EQUAL |
| 94FC4AD7 | 1474 ch | 1474 ch | ✅ EQUAL |
| F3C56554 | 346 ch | 346 ch | ✅ EQUAL |

**5/5 逐字节相等**，且 `answer.delta` 各帧长度非单调递增（268,201,34,22），
证明它们是**增量**而非重复全文。

结论：`answer.delta` 累积 == `messages.content`，`delta` 全文行确实是纯冗余。

---

## 一个既有失败（不是我引入的）

`HomeController.test.ts` 的 `resumes the same run cursor after host recovery` 失败：

```
AssertionError: expected 'open' to be 'closed'
```

**已用 git stash 验证：我的改动全部暂存后，该测试同样失败。** 是既有问题，
与本次重构无关（属于 `setHostAccessStatus` 关闭流的时机问题）。

---

## 数据模型变化

```
改前：  messages.content  +  run_stream(kind="delta")  +  run_stream(kind="answer.delta")
        权威              全文（冗余）                逐帧预览

改后：  messages.content  +  run_stream(kind="answer.delta")
        权威              唯一流式表示（逐帧或单帧全文）
```

非流式路径（evidence fallback / status_query）改为发布**一条 `answer.delta` 全文**，
客户端因此只需一种处理方式：追加。