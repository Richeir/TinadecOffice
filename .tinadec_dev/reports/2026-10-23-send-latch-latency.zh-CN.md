# 发送后的“正在发送”：延迟来自哪里、修了什么

日期：2026-10-23
范围：`apps/desktop`（`HomeController` / `ComposerBar`）、`apps/TinadecUI`（`ChatCard`）
任务：用户报告“点发送后按钮一直转到有回答为止，这个延迟确实得优化”

## 结论先说

后端不是瓶颈。预热后 Core / Gateway 的 `/api/v1/health` 是 2–3 ms（冷启动首次 81 ms），发送本身走的是 `POST /api/v1/sessions/{id}/interactions`，返回很快。用户看到的“慢”是**输入框把三件不同的事说成了一件**：

1. 发送在途（应当只有几百毫秒）；
2. 一整轮 run（可能几分钟）；
3. 发送后的本地收尾（标题补丁 + 六接口转录重读）。

其中第 2 件被并进了第 1 件，这正是“按钮转到有回答为止”的直接来源。

## 三个根因

### RC1：`busy` 被并入了 `working`

`ChatCard.vue` 传给 `ChatPanel` 的是 `c.busy.value || c.working.value`，而：

```ts
function syncWorking() { working.value = runStreams.size > 0 }
```

`runStreams` 在整轮 run 期间都非空。于是发送按钮的 spinner 与 `chat.sending`（读屏播报“正在发送”）从点下去一直持续到 run 结束——用户无法区分“已送达”和“还在等”。

### RC2：`busy` 覆盖了与发送无关的工作

`run()` 原本用整段动作守着 `busy`：

```ts
async function run(label, action) {
  busy.value = true
  try { await action() } catch (...) { ... } finally { busy.value = false }
}
```

`handleSend` 的动作里有：建会话 → 发 interaction → 标题 PATCH → `loadMessagesAndApprovals()`（六次接口）。也就是说“正在发送”把标题补丁和整次转录重读也算进去了。

### RC3：新会话的发送重复读了同一批接口

`handleSend` 尾部无条件 `await loadMessagesAndApprovals()`，而首条消息所在的新会话会在 `selectedSessionId.value = session.id` 时触发 `[selectedSessionId, selectedStorage]` watcher，watcher 里同样调用 `loadMessagesAndApprovals()`。后者一进门就 `sessionLoadAbort?.abort()`，结果：

- watcher 那一轮被取消；
- 同一批六次读原样重发一次。

Net 效果是转录更晚落定、发送闩更晚释放，而数据一次都没多拿到。

## 修复

- `ChatCard.vue`：`:busy="c.busy.value"`，并写明 `busy` 的语义（发送在途）与停止按钮读的是 `canStop`。
- `HomeController.run()`：签名改为 `action: (accept: () => void) => Promise<void>`。`accept()` 幂等，`finally` 仍会调用它，所以失败路径照旧释放。
- `handleSend`：在 `createInteraction` 返回、`settleSentAttachments(outgoing)` 之后立刻 `accepted()`。之后的 attachRun / 标题 / 转录读都不再占闩。
- `handleSend` 尾部：`if (requestedSession) await loadMessagesAndApprovals()`——新会话由 watcher 负责读，已存在的会话才补这一读。
- `ComposerBar.vue`：停止按钮改为 `v-if="canStop && (!spatial || !canSend)"`，发送按钮的互斥条件同步去掉 `busy`。若继续挂在 `busy` 上，发送一结束停止按钮就消失，而 run 还在跑。

## 一个被回退的尝试（值得记）

第一版把尾部的直读换成 `scheduleSessionRefresh()`（事件合并器），想顺手合并 250 ms 窗口。后果：**每次发送都留下一个真实定时器**。测试里某个发送用例在 250 ms 内结束，句柄就活到下一个用 `vi.useFakeTimers()` 的用例；假时钟一装，真定时器永不触发，`refreshTimer` 从此非空，该文件后续所有事件刷新被 `if (refreshTimer) return` 吞掉。实测表现为 `HomeController.test.ts` 的 replay 用例报 `expected "vi.fn()" to be called 1 times, but got 0 times`，而单独跑该用例是绿的。发送要读就直读，不要借用事件合并器。

## 验证（本轮亲手跑）

- `npx vitest run src/controllers/HomeController.test.ts src/components/ComposerBar.test.ts src/components/ChatPanel.test.ts` → **128/128**（`HomeController` 47 例含新增 1 例）。
- `apps/TinadecUI` 全量 → **176/176**。
- `npm run typecheck -w @tinadec/desktop`（vue-tsc）→ **0 错**。
- 变异验证：把 `busy.value = false` 从 `accept()` 摘掉 → 新用例变红（`expected true to be false`），恢复后全绿。新用例在转录读仍挂起时断言 `busy === false`，并断言发送后转录确实被读到过。

## 边界

- **RC4/RC5 未做**：第一条消息用的是 `pending-<uuid>`，服务端回执后换成服务端 id，`:key` 变化会把最新一轮整段重挂；以及 250 ms 合并刷新每次整表替换数组导致整篇重渲染。两者都与本次观测的“发送闩”无关，是独立的渲染成本。
- **渲染层时间未实测**：本机没有 Vite(5173)/CDP(9222)，安装版 `C:\Program Files\TinadecOffice` 的业务接口需要私有宿主头。上面全部是组件/控制器层证据；要看到真实按钮行为，需要重新构建/安装（或用 `TINADEC_DEV_CDP_PORT=9222` 起开发 Electron）后复看。
- **已存在的缺陷（未修，超出本次范围）**：发送失败时乐观的 `pending-*` 行会留在转录里。
