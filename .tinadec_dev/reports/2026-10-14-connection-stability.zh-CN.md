# 连接不稳定、加载慢：代码层排查

2026-10-14 · 分支 `fix/connection-stability`（基于 `main` e59f059）

反馈：“加载好慢，连接有亿丁点的不稳定”。本机无 Electron 与真实会话，以下按代码与最小复现排查。

## 主因：每个会话事件触发一次完整重读

`HomeController.handleSessionEvent` 对每个 `message.* / approval.* / tool.* / run.* / task* / supervision.* / context.* / step.*` 事件都 `await loadMessagesAndApprovals()`：一次 6 个 REST 读（消息、审批、审批规则、编排快照、整会话工具时间线、运行列表），其中消息与工具时间线是整份读取；每次还先 abort 上一次。

- 打开会话时 Core 先重放整段历史：N 个事件 = N 轮重读。客户端放弃的请求 Core 仍执行完，正文反而最后才到（“加载慢”），Core 被压满后心跳与流写出也被拖住（“连接不稳”）。
- 工具运行时事件连续到达，读取不断被中断重来。
- 这段代码在平面对话流之前就存在；新对话流让工具事件更早、更多，放大了它。

修复：重放期间不重读（会话切换本身已读过这些状态），首个 heartbeat 后若期间来过事件补读一次；实时事件合并为 250ms 后一次读取，同一时间最多一个，进行中再来事件只补一次。事件总线新增 `onOpen`（新连接开始重放）。测试：重放 50 个事件旧代码 50 次完整重读，新代码 0 次、heartbeat 后 1 次；实时 30 个事件 1 次。

## 次因：Gateway 的空闲超时

Elysia 在 Bun 上默认 `idleTimeout: 30` 秒（Bun 本身默认 10 秒）。最小复现：上游流静默时，旧 Gateway 约 32 秒切断（curl exit 18），修复后 45 秒仍在。Core 的事件流与 run 流都每 15 秒心跳，正常情况下碰不到；但 Core 被上面的重读风暴压住、心跳晚于 30 秒，或普通请求处理超过 30 秒时，连接会被切断。修复：全局 `idleTimeout` 取 Bun 上限 255 秒；两条 SSE 路由按请求 `server.timeout(request, 0)`。

## 兜底：客户端空闲看门狗

`ScopedEventSource` 原先在半开连接（睡眠唤醒、代理或网络静默断开）上会让 `read()` 永远等待，窗口停止更新而不报错。现在 45 秒（三个心跳周期）无任何字节即断开并带 `last-event-id` 重连。

## 未验证

Electron 实机、真实长会话的加载时长与 Core 负载未实测；需要合并后在实际会话里对比打开耗时与 Core 请求数。
