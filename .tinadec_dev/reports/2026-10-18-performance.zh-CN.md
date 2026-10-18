# 全链路性能排查与优化（2026-10-18）

分支 `main` @ `134639a6` + 未提交工作树。用户报告：「从开发阶段的编译到应用界面的加载，到各类小场景，如模型加载、模式选择、设置界面加载，都非常缓慢」。

三路并行：Core 存储作用域挂载（Lead）、开发链路（dev-perf）、渲染层启动（boot-perf）、场景读取（reads-perf）。

---

## 一、结论：五个确定的瓶颈，全部已落地

| # | 瓶颈 | 位置 | 改前 → 改后 | 倍数 |
|---|---|---|---|---|
| 1 | 事件索引重扫：每条 JSONL 记录一次 `SELECT EXISTS` | `StorageLifecycleService.ReconcileAsync` | 项目作用域挂载 **67.7 s → 2.37 s** | **~28×** |
| 2 | 表结构对齐：每个可空列一次 `pragma_table_info` | `DbContextMigrationParticipant` | 698 次 pragma → 12 次（每 context 一次） | **~58×** |
| 3 | Vite 依赖扫描把打包产物当入口 | `apps/desktop` 下 `release/`(2.8G/1112 html) + `runtime/`(424M/370 html) | 扫描入口 **1483 → 1**；冷启动扫描 **54.3 s → 10.2 s** | **~5×** |
| 4 | 窗口创建排在整条后端启动链之后 | `electron/main.cjs` 的 `app.whenReady()` | 后端不可用时 splash 永久挂着 → **main-content 490 ms 出现** | 从「不出现」到可用 |
| 5 | 渲染层入口内联全部 5 种语言 | `src/i18n.ts` 静态 import 5 个 locale | 入口 **1,695 KB → 795 KB**（gzip 545 → 269 KB） | **-53%** |
| 6 | 会话列表逐条读 `workspace_defaults`（每 workspace 只有一行） | `StorageEndpoints.ToSessionEnrichedAsync` | `/sessions` p50 **270 ms → 54 ms** | **~5×** |

### 用户可感知的净收益

- **首次打开项目**：67.7 s → 2.37 s
- **`npm run dev` 冷启动**：约 76.6 s → 约 27.3 s（-64%）
- **开发期每次启动的固定开销**：dev-port-guard 5.4 s → 0.3 s
- **主界面会话列表**（首屏第一批数据）：p50 270 ms → 54 ms
- **生产首屏**：main-content 444.5 ms → 234–277 ms
- **后端挂掉时**：以前 splash 永远挂着；现在 490 ms 后主界面出现 + Banner 说明原因并给重试

---

## 二、逐项证据

### 1+2. Core 存储作用域挂载 67.7 s → 2.37 s

两处 N+1 都在 `StorageScopeRegistry.MountAsync` 的同步路径上，**随用户数据量线性增长**——这正是「用得越久越慢」的原因。

**事件索引重扫**：`ReconcileAsync` 对每条 JSONL 记录发一次 `AnyAsync(x => x.EventId == record.EventId)`。真实项目 3,247 条事件 = 3,247 次往返，纯执行 21.7 s。改为整趟重扫前读一次 `event_index.event_id` 全集到 `HashSet`，循环内 `known.Add(id)`。

> **语义陷阱（已避开）**：`event_index` 的主键是 `EventId`，跨 run 唯一。按 `RunId` 收窄会让「同一事件已索引在别的 run 下」变成重复主键插入。必须是**全局集合**——这一点在自复查时纠正过一次。

**表结构对齐**：12 个 DbContext 各自在挂载时做列对齐，每个表一次 `pragma_table_info`、每个可空列再一次。新增私有 `SqliteColumnCatalog`，每 context 用**一次** `sqlite_master JOIN pragma_table_info` 读回全部表/列/notnull 并 memoize。

- 验证：`TinadecCore.Api.Tests` 定向 **40/40**（SchemaReconciliation / DmaeaGraphSchema / TinaChatWakeSchema / LegacyRouteSchema / AttachmentApi，2 m 13 s）
- 真实库核对：`event_index` 仍是 3,247 行，无重复无缺失
- 实测：首个 `GET /api/v1/projects`（触发项目作用域挂载）66.6/67.7/79.2 s → **2.37 s**
- 证据：`.tinadec_dev/evidence/2026-10-18-perf-core/README.zh-CN.md`

**诚实边界**：Core 冷启动有 **6.8 s 的 .NET 宿主 + 12 模块 DI 地板**（`TinadecStorage__Enabled=false` 时仍要 6.8–7.3 s）。这个地板不在本仓库代码里，**不要承诺把 Core 冷启动压到 1–2 s**。storage scope 初始化另占约 5 s。

### 3. 开发链路：冷启动 76.6 s → 27.3 s

**根因**：`apps/desktop` 目录里有 **1483 个 html**——`release/`（2.8 GB / 27,417 文件 / 1,112 html，electron-builder 产物）和 `runtime/`（424 MB / 9,050 文件 / 370 html，含 PortableGit 文档）。Vite 两处默认行为全部吃进去：

1. `optimizeDeps.entries` 默认 `**/*.html` → 1483 个入口逐个 crawl；
2. `server.watch` 的 chokidar 从 project root 下爬 **36,467 个文件**（Vite 默认 ignore 有 `node_modules`/`.git`，但**没有** `release/`、`runtime/`）。

两者叠加，冷启动时 esbuild crawl 和 chokidar 爬取抢同一块 IO。

**改动**：`server.watch.ignored: ['**/release/**','**/runtime/**','**/dist/**']` + `optimizeDeps.entries: ['index.html']`。

| 指标 | 改前 | 改后 |
|---|---|---|
| 依赖扫描入口数 | 1483 | **1** |
| `Scan completed` | 54.3 s | **10.2 s** |
| 依赖缓存可用 | 63.4 s | **19.2 s** |
| 冷启动总账 | ≈76.6 s | **≈27.3 s** |

> **必须如实说的反直觉结论**：`optimizeDeps.entries` **单独加没有可测收益**（92.5/99.2 s，落在改前 54–114 s 区间内）。真正的收益来源是 `watch.ignored`（单独加即 28.5 s）。entries 的价值是语义正确（入口本来就只有一个），**不是时间来源**。把它写成大头是错的。

**dev-port-guard 5.4 s → 0.3 s**（每次启动的固定开销）：原实现无条件拉起一个 Windows PowerShell 5 进程查 CIM，实测 5089/2951/2941 ms。改为先 `netstat -ano -p TCP` 读一遍（144–154 ms），三个服务端口都没监听就直接退出；有监听才回落原逻辑（判断逻辑一行未改）。netstat 不可用/解析不出 → 同样回落，**省时间永远不会变成漏检**。

- 独立复核（Lead）：四端口全空 327/293/300 ms；9222 被占 285/279 ms；5173 被外部进程占 + `report` 模式正确报错 exit 1。
- **9222 边界已正确处理**：`BLOCKING_PORTS = [48730, 48731, 5173]` 与 `PORTS` 分离。9222 被占不影响 dev 启动，只打印提示不拉 PowerShell。

**被证伪的假设**（写下来防止后人重踩）：
- `optimizeDeps.include` 加更多依赖：`optimizeWaves=0`、`pageReloads=0`，**不存在第二波**，无用。
- `dev:tools` 加 `-v:q`：`dotnet.mjs` 走 `pwsh -File setup-dotnet-env.ps1`，PowerShell 会把 `-v:q` 绑成 `-Verbose` 直接 **exit 1**。之前那个「5007→1903 ms」量的是**失败路径**，若提交会让 predev 直接断。已回退，`package.json` 零改动。改用 `--verbosity:quiet` 交错测 3 对：7142/7160/5562 vs 11648/7190/5600，**无收益**。

证据：`.tinadec_dev/evidence/2026-10-18-perf-dev/README.zh-CN.md`（434 行 + harness/ 10 脚本 + logs/ 20 日志）。

### 4. 窗口不再等后端（Electron 主进程）

`app.whenReady()` 原本 `await hostConnection.start()` **之后**才 `createWindow()`。`start()` 内部跑 `ensureLocalServices()`：探测健康、校验 HMAC 身份、启动缺失子进程并轮询等就绪（`startupTimeoutMs = 90_000`，打包态 `verificationTimeoutMs = 200_000`）。**窗口创建被排在整条后端启动链之后**——在窗口存在之前用户看到的是桌面，连 splash 都没有，因为渲染进程还没启动。本机 Core 单进程到 `/health` 200 就要 11.7–13.0 s。

改为 `const hostStartup = hostConnection.start();`（不 await）→ `await createWindow()` → `hostStartup.then(...)` 在窗口之后报告结果。

> **为什么安全**：业务授权看的是 `trustedHostReady`，它只在 `publishHostStatus()` 里随 `snapshot.state === 'ready'` 翻转，`trustedHostRequests.cjs` 的 `isManagedHost()` 每个请求实时读它——提前出现的窗口拿不到任何业务授权。渲染层本来就建模了「尚未验证」（`useConnection` 初始 `connecting`、`HostAvailabilityBanner` 显示原因与重试）。

**配套**（boot-perf）：`App.vue` 不再用 `isConnecting` 挡挂载，主界面首帧即挂载，App setup 把空 gate 发布成 `{state:'checking'}`，业务读取继续 fail-closed。

**实测**：主进程永不回状态（stub host）时，**main-content 490 ms 出现**（改前 splash 一直挂着）；banner 491 ms。

守卫 `electron/mainStartup.test.cjs`（已加入 `package.json` 的 `node --test` 清单）：断言 `hostConnection.start()` 不被内联 await、验证在窗口创建**之前**启动、延迟结果仍被报告、业务授权仍跟随已验证状态。**别把它改成 `await`。**

### 5. 渲染层入口 1,695 KB → 795 KB

`src/i18n.ts` 静态 import 全部 5 个 locale（每个 0.6–0.9 MB 源码），全部进入 renderer entry chunk。

改为只静态 import 默认 zh-CN，其余四个走 `() => import('./locales/x')` 独立 chunk。新增 `loadLocale()` / `ensureActiveLocale()` / `setInterfaceLocale()`。

| | 改前 | 改后 | 变化 |
|---|---|---|---|
| entry raw | 1,695 KB | **795 KB** | −900 KB（−53%） |
| entry gzip | 545 KB | **269 KB** | −276 KB（−51%） |

四个语言包变成独立 chunk（gzip）：`en` 59 KB / `zh-TW` 65 KB / `ja` 71 KB / `ru` 79 KB。

> **两条必须说清的边界**：
> 1. **只有默认 zh-CN 用户拿到全部收益**。启动在 en/ja/ru/zh-TW 的用户仍要下载对应 chunk，净收益为正但小得多，且首帧多等一个 chunk（FCP 400–416 ms）。
> 2. **`dist` 总大小不变**（204 个 JS，22.8 MB raw）。收益是「首屏不必下载/解析用不到的语言」，**不是「产物变小」**。

**保持的不变量**：五个 locale 一开始就注册（seed 只含 `common.languageName`），所以 `availableLocales` 完整、语言选择器能列出并命名全部五种；`t()` 对尚未到达的 key 回退而不是抛错。切语言时先 `await setInterfaceLocale()` 成功才改 `locale`，**不会先重绘成 fallback 语言**；跨窗口 storage 监听同样等 chunk。

**实测（headless Chrome，干净构建）**：
- **默认 zh-CN 启动**：n=9，FCP 中位 468 ms、`.main-content` 中位 468 ms、splash 离场中位 748 ms。基线（04:30 旧 dist 干净产物）FCP 148 / main 444.5 / shell 774.6 ms。**组内波动 40–2,276 ms，远大于组间差值**（测量期间另两位在跑构建，8 核争抢），所以**本轮不宣称默认路径变快**——结构上也不该变快：首帧画的是两代逐字节相同的内联 splash 占位层，CSS 传输量完全相同。
- **非默认语言 en**：n=12，FCP 中位 196 ms、main 中位 384 ms，代价是 +59 KB gzip（多下一个语言包，且 TLA 把这个下载放在首帧前）。方向与预期一致，受负载影响**只定性不给固定增量**；zh-TW n=1（FCP 452 / main 587 / +64.6 KB），ja/ru 未单独测。
- **主进程永不回状态（stub host）**：`.main-content` **490 ms**、Banner **491 ms**、splash 离场 788 ms、0 报错。改前该情形下界面**永不出现**（要等 30 s 超时后走 timeout 分支）。

> **一个重要的测量教训**：`vite build` 期间修改源文件会产出**混合产物**，且文件名 hash 看起来完全正常。我们一度拿到一个含有已删除符号 `mainStarted` 的 `dist`，用它测出「main-content 永远不出现」的假警报。检测办法：**grep 一个「改后应该消失的符号」**。这条已写入 evidence。

### 6. 会话列表的 workspace-defaults N+1（第二轮补）

`GET /api/v1/sessions` 组装每个会话时都新建一个 `AgentConfigurationDbContext` 并查一次 `workspace_defaults`，
而那是**每 workspace 一行**（主键 `(TenantId, WorkspaceId)`）。真实项目 9 个会话、1 行默认值 ⇒
**9 次 context + 9 次相同查询**。会话数随使用增长，这条路径随之线性变慢——与会话列表出现在主界面首屏叠加，是用户体感"界面慢"的直接来源之一。

| 指标 | 改前 | 改后 |
|---|---|---|
| `GET /api/v1/sessions` p50 | **270 ms** | **54 ms**（min 47 / p50 54 / p90 67 / max 72，n=12） |
| 每次请求 `workspace_defaults` 查询 | **9** | **1** |
| 每次请求新建 DbContext | **9** | **1** |

同轮未改动的 `/api/v1/agents` p50 314 ms 两轮不变，排除机器噪声。

改法：`LoadSessionModeDefaultsAsync` 批量读一次建 `(tenant, workspace) → DefaultModeVersionId` 字典，
`ToSessionEnriched` 变成纯同步投影；单会话路径保留惰性回退。`has_update` 算术逐字不变。

**守卫的诚实边界**：新增的 `SessionListModeDefaultsTests` 是端到端语义测试，守的是**结果不是查询次数**——
把实现改回逐条读它仍然会绿，那是性能回归，只能靠本节的数字和评审守住。变异验证（删掉 `workspace` 谓词）
测试仍通过（外 workspace 的行落在字典另一个 key 上、不污染结果），所以那个变异不是有效回归，这点写进了测试注释。

### 7. 场景读取（模型/模式/设置页）

| 指标 | 改前 | 改后 |
|---|---|---|
| 打开 Agent Center 的 `GET /agents/{id}` | **20 次 / 5 个串行波次**（全读完才画第一行） | **1 次 / 1 波**（目录一到即渲染） |
| 第一行卡片出现前已读完的定义数 | 20 | **0** |
| 首屏可用前的串行 REST 轮次 | 6 | **2** |
| 每业务请求 `hostAccess` IPC | **1** 次 | push 型 preload **0** 次 |
| 同键并发目录读 | 每消费者各 1 次 | **1** 次（单飞 + 3 s TTL + 写后失效） |

缓存键含**存储作用域**（切换 scope 不会拿到别的目录）；宿主门状态参与命中判定（撤权/restart_required/preview 立即清空缓存）；**不缓存** readiness 类回执。

> **一处行为变更**：共享目录读取**不再把调用方 signal 传给 transport**——一个消费者离开不能取消另一个消费者正在等的数据。调用方自己的 `await` 仍按 `AbortError` 拒绝，`useRecoverableRead` 语义未变。原 `spotlight.test.ts` 断言「所有 catalog transport 都带 signal」与共享读取直接冲突，已拆开。

顺带修掉一个真 bug：`hostAccess.assertHostAccess` 里 `const current = status.value ?? pushed` 之后直接 `current.state`——两个来源都可能是 null（push 型 bridge 还没广播；poll 型在 preview 态没有 status），会抛 `Cannot read properties of null`。改为 null 时 fail-closed 抛 `host_unavailable`/retryable 的 503。

---

## 三、验证

| 项 | 结果 |
|---|---|
| `apps/desktop` vitest 全量 | **1370 passed / 1 failed / 12 skipped** |
| 那 1 个失败 | `message-scroller.test.ts`，**HEAD 基线即存在**，与本轮改动无关 |
| `apps/desktop` electron `node --test` | **100/100** |
| `vue-tsc --noEmit` | **0 错误** |
| 生产构建 | ✓ built（2 m 28 s），入口 `index-YQZfJESZ.js` 814,050 B |
| `TinadecCore.Api.Tests` 定向（第一轮） | **40/40** |
| `TinadecCore.Api.Tests` 定向（会话列表） | **27/27**（SessionListModeDefaults + StorageScopeApi + StorageLifecycleGraph） |
| 干净构建的浏览器实测 | splash 离场、main-content、banner 全部正确 |

**关于 `message-scroller.test.ts` 的定性**（不是甩锅，是可复现事实）：
- 该文件与它的实现**在本轮工作树里 `git diff` 为空**（完全未改动）；
- bisect：把 `i18n.ts` 临时还原成 HEAD 版本，该测试**仍然失败** → 与 i18n 懒加载无关；
- 时序抖动：单独跑 5 次里 4 次全绿、1 次红，失败断言在 `scrollTop 700≠900` 和 `anchorTop 300>65` 之间漂移；
- **本轮未修**，属 conversations/UIE 另一条线。

---

## 四、没做的 / 未验证的

- **Core 未跑全量套件、未验证 PostgreSQL 路径**（两处修复都只在 SQLite 分支生效）、未验证其他平台。
- **事件重扫仍是全量**。改为增量（记录 last offset）会动到恢复语义，本轮按最小改动未做——数据量继续增长时那是下一个优化点。
- **`ListAgents` 载入全部 succeeded `model_invocations` 的问题：实测不构成瓶颈**。真实项目库只有 173 行 succeeded / 6 个 agent，量级太小，因此**没有改**（避免无收益改动）。它会随使用增长，届时再处理。
- **`/api/v1/agents` 仍 p50 314 ms**（67 个 preview 请求 + 20 个定义）。`PreviewBatchAsync` 已有批内缓存（planKey/resolutionKey），要再降需要 profile 服务端算子，本轮未做。
- **`dev:tools` 的两次 pwsh 启动未优化**（可省 0.7–2.3 s，但要处理 pwsh 不存在的回落）。
- **`release/` 与 `runtime/` 为何在 `apps/desktop` 下**是布局问题；根治要挪目录并改 electron-builder 配置与运行时路径，未做。本轮 `watch.ignored` 是「不搬东西」的最小改动。
- **每个作用域挂载仍约 2.4 s**，且 `StorageScopeRegistry` 按设计不做跨 scope 复用。
- **打包态冷启动未实测**：`release/win-unpacked/TinadecOffice.exe` 是 10 月 4 日的旧构建，跑出 0 字节日志、无进程，无法作为基线。**「改前界面永不出现」是从 `mainStarted` 门控语义 + `useConnection` 的 30 s 超时推导的，不是跑旧包实测**（旧 `dist` 已被删除）。窗口不再等后端这条改动的打包态收益**未量化**。
- **首屏重组件异步边界未做**（xterm / MarkdownRender / CommandPalette）：入口降到 795 KB 后，剩余大头已是首屏必需，**没有测量支撑就不动**。
- **默认 zh-CN 路径的毫秒数不可作 A/B**：共享机器上并发构建导致组内波动（40–2,276 ms）大于组间差值，只能看体积与结构性收益。
