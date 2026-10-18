# 场景读取性能：共享读取缓存 / Agent Center 目录优先 / hostAccess IPC

日期：2026-10-18 · 负责人：reads-perf（task-3）· 分支：main @ 134639a6

## 结论

| # | 改动 | 改前 | 改后 | 依据 |
|---|------|------|------|------|
| 1 | 只读目录接口共享读取（单飞 + 3s TTL + 写后失效） | 同一轮内每个消费者各发一次 | 同键并发只发 **1** 次 | `src/apiReadCache.test.ts`（11 例） |
| 2 | Agent Center 目录优先、定义按需 | 20 个定义 **5 个串行波次**，全部读完才画第一行 | **1** 个定义（仅当前配置项）、**1** 个波次，目录先渲染 | `src/pages/SettingsPage.readBudget.test.ts`（2 例） |
| 3 | `hostAccess` 每请求 IPC | 每个业务请求 **1** 次 `getHostStatus` IPC | push 型 preload 下 **0** 次 | `src/lib/hostAccessPush.test.ts`（6 例） |

## 1. 共享读取缓存（`src/lib/readCache.ts` + `api.ts`）

覆盖且仅覆盖只读目录接口：`listAgents` / `listModelProviders` / `listModelRoutes` / `listAgentModeTopologies` / `listAgentCandidates`。**不缓存** `/api/v1/readiness`、`model-readiness`、`model-catalog-readiness` 等回执类读取。

- **单飞**：同键并发共享一个 Promise（`apiReadCache.test.ts` "shares one request between callers"）。
- **TTL = 3000 ms**：覆盖「一次交互」——命令面板展开、设置页切页、模式下拉——同时让别处产生的变更在 3 秒内自然可见。写操作不等 TTL：`requestResult` 在非 GET/HEAD 成功后立刻 `invalidateReadCache()`。
- **键含存储作用域**（`selectedStorageId()`）：切换存储不会拿到另一个作用域的目录。
- **宿主门状态参与命中判定**：`setHostAccessStatus` 每次状态**真实变化**（撤权 / restart_required / preview）都会清空缓存；同状态重发不清空（那是每请求重校验的常态）。
- **取消语义**：共享请求**不带调用方 signal**（一个消费者离开不得取消另一个消费者正在等的数据），但该调用方自己的 `await` 仍然按 `AbortError` 拒绝。`useRecoverableRead` 的取消/迟到保护因此原样保留——它取消的是自己的等待，不是共享传输。

### ⚠ 行为变更：共享目录不再把调用方 signal 传给 transport

`lib/spotlight.test.ts` 原有一条断言要求**所有** catalog 请求的 transport 都带调用方的 `AbortSignal`。共享读取与它正面冲突，二者只能取一：

| | 改前 | 改后 |
|---|---|---|
| `/api/v1/agents`、`/api/v1/model-providers` 的 transport | 带调用方 signal，调用方 aborted 即中断 HTTP | **不带**；共享请求独立于任何调用方存活 |
| 其它直连接口（projects、sessions、modes、prompt-fragments、grep 等） | 带调用方 signal | **不变**，仍逐调用方取消 |
| 调用方自己的 `await` 被取消时 | 以 AbortError 拒绝 | **不变**，仍以 AbortError 拒绝 |

理由：命令面板与设置页可能同时等同一份目录，任一方关闭不得取消另一方正在等的数据。调用方并不会因此「取消不了」——它拒绝的是自己的等待，不是共享传输。该保证由 `apiReadCache.test.ts` 的 "keeps the shared read alive when one caller aborts" 守住。`useRecoverableRead` 的取消/迟到保护语义未变。

## 2. Agent Center：目录先渲染，定义按需

改前（实测）：`loadAgentCenterData` 先用 `Promise.all` 取目录等五项，然后 **`for (start += 4)` 的 4 并发波次**把 **全部 20 个** `GET /api/v1/agents/{id}` 读完，才组装 `agents.value` 并渲染第一张卡。

改后：目录读取一回来就组装行并渲染；`openAgentConfig` 只在真正要配置某个 agent 时才 `ensureAgentDefinition(id)` 读一次定义并合并进该行。

保留的既有契约（`SettingsPage.agentPack.test.ts` 12 例全绿）：失败保留旧数据、不虚构空白定义、草稿保护、`data-testid="agent-definition-read-failure"` 及其 retry、部分失败 `agent-center-partial-failure`、重连不重置脏编辑器、取消的旧响应不覆盖新目录。

```
# 实测（SettingsPage.readBudget.test.ts，20 个 agent 的目录）
改前：getAgent calls=20  waves=5  cardsBeforeFirstDefinition=0
改后：getAgent calls=1   waves=1  cardsBeforeFirstDefinition=20
```

**这一节只给实测数字。** 打开一次 Agent Center 的传输数：

| 指标（实测） | 改前 | 改后 |
|------|------|------|
| `GET /api/v1/agents/{id}` 定义读取次数 | **20** | **1**（只读当前配置项） |
| 定义读取串行波次 | **5**（4 并发 × 5 轮） | **1** |
| 第一行卡片出现前已读完的定义数 | **20**（全部读完才画） | **0**（目录一到即画） |
| 目录读取返回时已渲染的卡片数 | 0 | 20 |
| 首屏可用前的串行 REST 轮次 | 目录 1 轮 → 定义 5 轮 = **6** | 目录 1 轮 → 定义 1 轮 = **2** |

**不写秒数。** 本轮没有对带 20 个 agent 的真实 Core 做端到端计时，任何「秒」都只能由延迟 × 次数推出来；推算值混进结论表会让人误以为是量出来的。Core 的实测延迟（`/api/v1/agents` ≈ 0.50–0.60 s、单定义 ≈ 0.18–0.28 s）由 Lead 另行测得，可作为换算依据，但**不是本报告的测量结果**。

## 3. `hostAccess` 每请求 IPC

改前：`assertHostAccess` 每个业务请求都 `await readHostStatus(host)` = 一次 `tinadec:host-status` IPC。改后：preload 若暴露 `onHostStatusChanged`（main 在状态变化时广播 `tinadec:host-status-changed`，`useConnection` 收下后经 `setHostAccessStatus` 发布），直接采用已发布的状态，不再逐个请求问一次；**不暴露该方法的旧 preload 仍然逐请求询问**。

**没有 TTL**，只有事件：`restart_required` 短路保留，撤权 / preview 由推送状态立即生效。fail-closed 未放宽——未知状态（两个来源都为 null）由 Lead 追加的分支抛 `host_unavailable`/retryable 的 503，不放行。

## 4. 全量套件里的两个失败（均与本轮改动无关）

全量 `npx vitest run`：**1366 passed / 2 failed / 12 skipped**。两个失败的文件都不在本轮改动的导入图内（不 import `api` / `readCache` / `hostAccess`）：

| 测试 | 现象 | 结论与证据 |
|---|---|---|
| `src/App.entry.test.ts` `.app-splash` | 采集时 1 例失败 | **现已 12/12 绿**（boot-perf 在本轮内修掉） |
| `src/components/ui/message-scroller/message-scroller.test.ts` scrollTop 700≠900 | `opens at the end and follows new rows...` 1 例失败 | **HEAD 基线即失败，与本轮无关。** 非并发抖动：单独跑稳定 3/3 失败。bisect：把 `i18n.ts` 临时还原成 HEAD 版本，该测试**仍然失败**——与 i18n 懒加载无关。该测试文件与其实现 `git diff --stat` 均为空。**本轮未修**，属 conversations/UIE 另一条线。 |

## 复现

```bash
cd apps/desktop
npx vitest run src/apiReadCache.test.ts src/lib/hostAccessPush.test.ts src/pages/SettingsPage.readBudget.test.ts
npx vitest run src/pages/SettingsPage.agentPack.test.ts src/pages/SettingsPage.smoke.test.ts src/pages/SearchNavigation.test.ts
npx vue-tsc --noEmit -p tsconfig.json       # 0 错误
```

## 未做 / 边界

- **没有端到端计时。** 上表全部是客户端传输次数/时序，来自 `SettingsPage.readBudget.test.ts` 的计数（真测）。带 20 个 agent 的真实 Core 上的秒级耗时本轮未测，故不呈现。
- 未改 `useConnection.ts`（boot-perf 负责）；失效挂在 `setHostAccessStatus` 上，宿主事件自然触发。
- 共享目录读取在 3 s 内不重新校验宿主；撤权依赖推送事件到达。旧 preload（无推送）仍逐请求校验，退化安全。
