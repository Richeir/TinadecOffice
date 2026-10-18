# 彻底重构清单：流式链路里「不该存在」的东西

**日期：** 2026-10-18
**依据：** 用户要求「更稳妥、更彻底的重构，不该有的地方就重构，不兼容的地方就不兼容」

这份清单不是修复列表，是**删除列表 + 重构列表**。每条都带实测证据。

---

## 一、必须删除的冗余

### R1. 答案在数据库里存了三份（重复率 100%）

实测（真实项目库 5 个 completed run）：

| run | 1) messages.content | 2) run_stream kind=delta | 3) answer.delta 合计 |
|---|---|---|---|
| 6e36e2e4 | 817 B | 817 B | 817 B（2 帧） |
| 94fc4ad7 | 2866 B | 2866 B | 2866 B（15 帧） |
| 1ad5ba8c | 525 B | 525 B | 525 B（4 帧） |
| 29a7f645 | 615 B | 615 B | 615 B（3 帧） |
| f3c56554 | 804 B | 804 B | 804 B（2 帧） |

**字节数逐字节相等。** 同一个答案：
- messages 存权威消息（**必须保留**）
- run_stream kind="delta" 再存一遍全文（**冗余，删**）
- answer.delta 逐帧存预览，最后被 delta 覆盖（**改为唯一流式来源**）

代码位置：FullDuplexRunEngine.cs:4931 那个 AppendRunStreamAsync(..., "delta", ...)。

删掉后 projectRunReply（apps/desktop/src/lib/runReply.ts）的整个 provisional 替换逻辑失去意义——
**它存在只是因为有两个 delta 语义**。一并简化：

---

## 二、必须重构的设计缺陷

### D1. 渲染数据源是 DB 轮询（架构病灶）

FullDuplexRunCoordinator.cs:599 的 FollowAsync：

- while 循环每 150ms 调 ReplayRunStreamAsync（StorageLifecycleService.cs:1074 查 db.RunStream 表）
- 渲染延迟下限 = 轮询间隔 + 一次 DB 查询
- **落盘成了渲染的必经之路**

这就是用户说的「渲染被 DB 绑死」。DSH 的做法是投影层（内存）+ change feed，
日志只做持久化，两者由框架连接但互不阻塞。

### D2. 「终止补丁」在用谎言掩盖竞态

FullDuplexRunCoordinator.cs:614-660：

1. 读到 run 终态，但读不到 done 行（两个独立事务）
2. 重试 3 次 ReconcileTerminalRunAsync
3. 仍失败 → **伪造一个 done 帧** yield 给前端

前端无法分辨真假 done。这是设计缺陷的必然产物：因为 done 和终态不在同一事务里。

重构后 done 由写入方保证（或内存投影直接发），这段整个删除。

### D3. streamAnswer 是散落的布尔开关，不是架构

全仓 6 处 CreateModelFactory 调用，其中只有 2 处（改后）传 streamAnswer: true：

| 行 | 调用 | streamAnswer | 是否该流式 |
|---|---|---|---|
| 4639 | GenerateInteractionResponseAsync（追问） | true（本次修） | ✅ 是 |
| 5349 | GenerateMeetingResponseAsync（主答案） | true | ✅ 是 |
| 2646 | ExecutionAgent（worker） | **false** | **应该重新考虑** |
| 5834/5901/6012/6151 | 治理旁路 | observeOutput: false | ✅ 否（设计正确） |

**worker 那行是个悬案**：它产出 392 帧流式文本（真实运行 1EC15446 实测），
但这些文本只进事件表不进渲染通道。该不该让它进？
按用户要求「工作过程也算输出」，答案是**该进**——但不是进正文区，是进工作过程区。

这说明 streamAnswer 这个布尔开关本身就是错的抽象：
**真正的维度不是「流不流」，而是「流到哪一层」**（正文层 / 工作层 / 不流）。

应该改成枚举：

```csharp
public enum AnswerStreaming
{
    None,        // 治理调用：只记录，不渲染
    WorkLayer,   // worker：流到工作过程区
    AnswerLayer, // meeting：流到正文区
}
```

---

## 三、不该保留的兼容

用户明确说「不兼容的地方就不兼容」。以下都是应该直接删、不留后路的：

| 项 | 现状 | 处理 |
|---|---|---|
| `delta` kind | 与 answer.delta 双语义 | **直接删，不改名兼容** |
| projectRunReply 的 provisional 状态机 | 为双语义而存在 | **直接简化** |
| terminalRepairAttempts | 竞态补丁 | **直接删** |
| ReconcileTerminalRunAsync 在 FollowAsync 里的调用 | 同上 | **直接删** |
| FollowPollInterval 150ms | 轮询设计 | 投影改造后**不再需要** |

⚠️ 这些都是 `/api/v1` 内部语义与同仓前端，按项目规则
（PUBLIC API VERSION RULE：未见正式版本，破坏性变更直接改 /api/v1，不留兼容别名）
**不需要任何兼容层**。

---

## 四、执行顺序（彻底重构版）

原则：**每一步都做完整，不留半成品；后一步依赖前一步的干净基础。**

### 步骤 1（已完成）：补 streamAnswer
- FullDuplexRunEngine.cs:4639 加 streamAnswer: true
- 编译通过，DmaeaEndpointTests 6/6 绿
- 价值：追问回复从「完全没有流式」变成「有」

### 步骤 2：删掉 delta 双语义（R1+R2）
改动：
- 删 FullDuplexRunEngine.cs:4931 的 AppendRunStreamAsync(..., "delta", ...)
- 前端 runReply.ts 简化，删 provisional 状态机
- 保留 answer.delta 作为唯一流式正文

**必须先解决**：删掉后，messages 提交前前端靠什么显示完整答案？
答案：answer.delta 已经是逐帧全文的累加，`done` 帧到来时文本已完整。
`delta` 存在的唯一理由是「answer.delta 可能因 streamAnswer=false 而没有」，
但现在所有面向用户的路径都开了 streamAnswer，所以它确实多余。

### 步骤 3：streamAnswer 布尔 → AnswerStreaming 枚举（D3）
改动：
- 定义 3 值枚举
- 6 处调用点按语义重新标注
- worker 从 false 改为 WorkLayer（**这是让工作过程可见的核心**）

### 步骤 4：IRunStreamProjection 内存投影（D1）
改动：
- 新增端口 + 内存实现（watermark + change feed）
- engine 的 publish 双写：projection.Apply + AppendRunStreamAsync
- FollowAsync 改为投影优先、DB 兜底

### 步骤 5：删掉 terminalRepair 补丁（D2）
- 投影层保证 done 帧必达，补丁失去存在理由
- 直接删 614-660 整段

### 步骤 6：落盘窗口聚合
- 500ms 聚合 + 终态强制 flush

### 步骤 7：Vue 侧工作过程渲染
- worker 文本独立成条目（不再塞进 ReasoningEntry.output）
- answer.started 前占位
- shallowRef / v-memo 优化

---

## 五、每步的验证要求

| 步骤 | 验证 |
|---|---|
| 1 | 编译 + DmaeaEndpointTests 6/6 ✅ 已完成 |
| 2 | 编译 + DmaeaEndpointTests + 前端 vitest |
| 3 | 编译 + AgentFramework 全量（枚举改动面广） |
| 4 | 编译 + DmaeaEndpointTests + 真实起 Core 观察 SSE |
| 5 | 同上 + 断言不再伪造 done |
| 6 | 崩溃恢复测试：杀进程后 DB 里答案必须完整 |
| 7 | 前端 vitest + 真实 Electron 观察 |

---

## 六、诚实边界

1. 步骤 4-5 会动 Core 主干（FollowAsync 是 SSE 的唯一入口），改动面大。
2. **样本只有 5 个 completed run**，不外推到所有模型/所有场景。
3. 我读的 DSH 是 minified bundle，只借鉴分层思想，不照搬 Cordis 服务模型。
4. 步骤 2 删掉 delta 后，如果有第三方客户端依赖它，会破坏——
   但按 PUBLIC API VERSION RULE，未发布正式版本不留兼容。
5. 我没有在真实 Electron 里做视觉 A/B，最终观感需用户确认。

---

## 七、一句话

**删掉三份重复存储、删掉伪造 done 的补丁、把布尔开关换成层次枚举、
把渲染从 DB 轮询换成内存投影。**
这不是优化，是把这个功能重新做对。