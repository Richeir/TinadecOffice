# 设置页冷启动收尾：一次往返代替七次、分档缓存、耗时观测

日期：2026-10-25
范围：`TinadecGateway`（`src/timing.ts`、`src/runSessionLookup.ts`、`src/index.ts`、`src/config.ts`）、`apps/desktop`（`lib/readCache.ts`、`lib/requestTiming.ts`、`lib/backendRequest.ts`、`api.ts`、`pages/SettingsPage.vue`）

## 这一轮做了什么

设置页的模型中心/智能体中心冷启动原本一次挂载要打七次独立的读（providers、provider-templates、model-routes、acp/adapters、model-readiness、model-catalog-readiness、readiness）。它们彼此没有数据依赖，只是被摆在了同一个 `Promise.all` 里。改成：

- **一次往返**：Gateway 新增 `GET /api/v1/model-center/snapshot`，内部并行取回七项，每项单独带 `ok/status/data|error`。一个分区失败只降级它自己，不再让整页 `Promise.all` 一起拒绝。逐端点路由**一个不少地保留**，仍是默认可用路径（旧网关、快照结构不合法时回落到那里）。
- **客户端单飞 + 分档 TTL**：`lib/readCache.ts` 从单一 3 s 改成按端点性质分档 —— 描述「配置目录」的投影（provider templates、ACP adapters、catalog readiness）走 5 分钟长档；描述「运行时现在怎么样」的 receipt（`model-readiness`）留在 3 s 短档。任何写操作完成都会 bump generation、清空全部条目，所以长档不会把自家写入的数据读旧。
- **一次编排查询代替两次**：`task-nodes` 与 `context-versions` 对同一次 run 的 404 回落，原本各自去问一次 `/orchestration`。新增 `src/runSessionLookup.ts`，同一 run 的查询共享（2 s TTL、256 条上限、先删后插的有界淘汰），面板刷新只付一次往返。
- **耗时观测**：Gateway 给每个响应加 `Server-Timing`（含 `total` 与路由主动测量的分段），错误与 404 也有（它们不经过 `onAfterHandle`，所以在 `onError` 与两处 `onRequest` 早退里也调用了发头函数）。日志按 `TINADEC_GATEWAY_PERF_SAMPLE` 采样，**默认 0 = 只出响应头、不写日志**。

## 收尾时补的七个缺口

上一轮把机制做出来了，但没接完。逐条都有代码证据：

**1. `server-timing` 没在 CORS 暴露清单里（功能性，最重）。**
渲染层对 `127.0.0.1:48730` 是跨源（打包态 `app://bundle`，开发态 `http://127.0.0.1:5173`），浏览器会把未列入 `access-control-expose-headers` 的响应头藏起来。清单原本只有 `etag, x-request-id, x-tinadec-storage-id, content-disposition`，于是 `requestTiming.ts` 里 `response.headers.get('server-timing')` 在真实应用里永远返回 null，而 Node 测试看不到这个差别（不强制 CORS）。补进清单，并在 `storageProxy.test.ts` 那条既有 CORS 断言里加一条 `/server-timing/` —— 去掉即红。

**2. 观测给自己加了成本。**
`observeRoundTrip` 原来每个读都无条件执行（构造采样对象 + 解析 header 字符串），而开关只控制打不打印，返回值也没有消费方。改成 `if (roundTripTimingEnabled) observeRoundTrip(...)`，关闭时热路径只剩一次布尔判断。新增用例断言关闭时一次采样都不产生。

**3. 首屏叠了两套骨架（自己引入的回归）。**
`centerFirstLoadPending` 的 `v-if` 与 `personal` 的 `v-else-if` 组成一条链，但 `general/storage/model/agentCenter` 是另一组独立的 `v-if`。于是 model/agentCenter 首载时，页面级骨架和分区自带骨架（各自同条件）同时渲染。已删掉页面级那块与它的 computed，`personal` 恢复 `v-if`；`center-first-load` / `center-first-load-head` 两个类在 `settings.css` 里本来就没有规则。

**4. 一个分区降级被报告成「整页加载失败」。**
`reportModelCenterPartialFailures()` 在数据**已应用之后**抛错（这是 `status.error` + 重试动作的驱动源），而整页横幅的条件是 `modelCenterFailure`，于是「中心数据加载失败」会和「部分详情读取失败，已保留可用内容」同屏出现 —— 前者是假话。横幅条件收紧为 `modelCenterFailure && !modelCenterOverview`：只有什么都没读到时才说整页失败。

**5. 契约客户端没重新生成。**
按 `openapi.external.json` 重新生成后对比，`schema.d.ts` 缺 `"/api/v1/model-center/snapshot"`；同时 `main` 上**本来就**缺 7 条 `"/auth/{begin,callback,check,login,logout,me,profile}"`（快照里有，客户端里没有）—— 登录态那几个提交加了网关路由但没重跑生成器。所以 `check:drift` 在本次改动之前就是红的。已一并重新生成。

**关于 `check:drift` 的读数边界**：脚本是 `generate:client && git diff --exit-code -- src/generated/`，比的是**已提交的 HEAD**，所以工作树未提交时它必然报红，这与生成是否正确无关。这一轮用两条真证据代替它：①对 HEAD 做同样的集合比对，`261` 条路径里缺 `7` 条（就是上面那批 `/auth/*`），证明红灯在本次改动前就存在；②对当前快照比对生成结果，`262` 条路径 / `304` 个操作**零缺失**，且连续两次生成字节一致（幂等）。提交之后 `check:drift` 会自然变绿。

**6. 新主路径在页面层零覆盖。**
`SettingsPage.models.test.ts` 与 `smoke` 的 api 代理对 `get*` 返回 `{}`，`isModelCenterSnapshot` 判假，走的**永远是回落路径**。新增 `SettingsPage.modelSnapshot.test.ts` 钉两件事：快照可用时模型清单来自 `parts.providers.data` 且 `listModelProviders`/`listModelRoutes` 一次都没被调用；单个 part 失败时其它分区照常渲染、出现分区失败列表、**不**出现整页横幅、且 `status.error` 仍被调用。

**7. 三处名不副实。**
`requestTiming.ts` 的注释写 `TINADEC_DESKTOP_TIMING=1`，代码读的是 `VITE_TINADEC_DESKTOP_TIMING`（Vite 只向渲染层暴露 `VITE_` 前缀，照注释做永远打不开）；`LOGGED = ENABLED` 顶着一句「按 info 打会刷屏」的注释却是 `console.debug`，别名已删；`settingsColdStart.test.ts` 的「第二次挂载」用例体只跑了一批，改成真正共用同一个在途读取（`Promise.all`），并单独保留一条「回落路径是 7 次读」。

**8. 新增的 reduced-motion 块把既有的那个挤出了契约测试的切分位置（本轮验证时发现并修掉）。**
`settings.css` 在 spinner 旁边又写了一个 `@media (prefers-reduced-motion: reduce)`，而文件末尾既有的那个大块里明确写着「in this file's single reduced-motion block」。`settingsCssContract.test.ts` 用 `css.split('@media (prefers-reduced-motion: reduce)')[1]` 取「那一个块」，多出一个之后取到的是短的 spinner 块，于是 `neutralizes entrance keyframes` 与 `neutralizes interactive element transitions` 两条立即变红。修法是把 `.center-stale-spinner { animation: none !important; }` 并进既有块、删掉独立块 —— 文件仍然只有一个 `reduce` 块。教训：**往这个文件加 reduced-motion 规则时不要新开 media 块**。

## 验证（本轮亲手跑）

| 项 | 读数 |
|---|---|
| `TinadecGateway` `bun test src` | 109/109 通过（17 文件，含 5 条观测用例与新增 CORS 断言） |
| Desktop 定向 `requestTiming + backendRequest + apiReadCache + settingsColdStart` | 33/33 |
| Desktop `SettingsPage.modelSnapshot` | 2/2 |
| Desktop `SettingsPage.models` / `SettingsPage.smoke` | 3/3、5/5 |
| `vue-tsc --noEmit` | 0 错 |
| `settingsCssContract` | 10/10（修掉新增的第二个 reduce 块后恢复） |
| 设置页 5 套件（models / smoke / agentPack / readBudget / modelSnapshot） | 24/24 |
| 生产 `vite build` | 退出 0，`✓ built in 25m 34s` |
| Desktop 全量基线（本轮改动前跑，作对照） | 1606 passed / 9 failed / 12 skipped（198 文件） |

构建产物的源码一致性按「改后该消失/该出现的符号」核对，不看 hash：`model-center/snapshot` 与 `desktop-timing` 出现在 `index-*.js`、`center-stale-spinner` 出现在 `SettingsPage-*.css`；`centerFirstLoadPending` / `center-first-load` 在产物中**零命中**。CSS 产物里 `.center-stale-spinner{animation:none!important}` 与 `.spinning` 同处于一个 reduced-motion 块内，证明它是并入后的源码而不是被删掉的那个独立块。

全量那 9 个失败是既有条件，与本轮无关：`ConversationView` 套件会去连默认 48730，无宿主时挂起（AGENTS.md 已登记）；`message-scroller` 的锚点时序抖动也是既有登记项；另有 2 个 vitest worker 启动超时（`JumpToLatest`、`CodeEditorCard`），属并行负载下的池故障，不是断言失败，且这两个文件不引用本轮改动的模块。

## 诚实边界

- **没有真实冷启动毫秒数**：本机没有运行中的 Core/Gateway（48730/48731 均不可达），也没有 Electron + CDP，所以本轮全部证据是「HTTP 调用次数」而非墙钟时间 —— 这也是 `settingsColdStart.test.ts` 从一开始就采取的立场：调用次数是「等待」的机制，且不依赖跑测试的机器有多快。**不宣称**真实观感、首屏时间或按钮手感。
- **SSE 与字节代理拿不到 `Server-Timing`**：Elysia 里 handler 直接返回自带 `Response`（`proxySse`、`proxyRaw`/附件下载）时 `set.headers` 不参与合并。给这些路径补头要改头合并语义，是独立项，未做。
- **`RC4/RC5` 未动**：`pending-*` 乐观行换成服务端 id 导致最新一轮整段重挂；250 ms 合并刷新整表替换数组导致整篇重渲染。两者都是渲染成本，与本次链路无关。
- **未提交**：工作树里除本次改动外还有一批同主题的在途改动，本轮未执行 `git commit` / `push`。
