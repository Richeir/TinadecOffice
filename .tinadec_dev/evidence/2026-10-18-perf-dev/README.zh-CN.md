# dev 阶段构建/启动性能证据（dev-perf）

日期：2026-10-18
范围：开发期 `npm run dev` 的启动链路（Vite 依赖扫描、文件监听、predev 各步骤、启动器等待逻辑）。
不在范围：renderer 源码、electron 主进程、TinadecCore 业务代码。

机器：Intel Core Ultra 5 226V / 8 逻辑核 / 15.6 GB / Windows 10.0.26200 / Node v26.5.0 / Vite 7.3.6。
**重要前提：测量期间这台机器上有其他 agent 的构建和编辑器在跑，8 核长时间处于争抢状态。**
所有数字都是"同机、同 harness、尽量同日"的对照，绝对值会有 ±30%~2x 的抖动，
所以下文的结论一律看**同一轮内的相对差**，不要跨表比较绝对值。

## 0. 结论先行

| # | 改动 | 改前 | 改后 | 收益 |
|---|---|---|---|---|
| 1 | `apps/desktop/vite.config.ts`：`server.watch.ignored` 排除 `release/ runtime/ dist/` | 冷启动依赖扫描 54.3 / 59.3 / 93.7 / 107.6 / 113.9 s（中位数 93.7） | 单独加即 24.1 / 28.5 / 39.2 s（中位数 28.5） | 冷启动省约 **65 s** |
| 2 | `apps/desktop/vite.config.ts`：`optimizeDeps.entries: ['index.html']` | 扫描入口 **1483 个**（其中 1482 个是打包产物里的 html） | **1 个** | **单独加没有收益**（92.5/99.2 s，仍落在改前区间内）；价值是语义正确，并与 #1 叠加成 **54.3 s → 10.2 s** |
| 3 | `apps/desktop/vite.config.ts`：VueMcp 插件默认关闭（`TINADEC_VUE_MCP=1` 才开） | 每次启动起一个 SSE 服务并往 index.html 注入 overlay 模块 | 无 | 单次粗测：warm 页面整载 6.0 s → 4.0 s、请求 492 → 482（§8，方向性） |
| 4 | `scripts/dev-port-guard.mjs`：netstat 快速路径 | **5 384 ms**（每次都拉起一次 Windows PowerShell 5） | **267 / 295 / 349 ms**（Lead 复核 300 / 293 / 327 / 285 / 279 / 298 ms） | 每次 `npm run dev` 省约 **5.1 s** |
| 5 | `apps/desktop/scripts/dev.mjs`：`waitForVite` 上限 30 s → 180 s + 快速失败 | 冷启动实测 54.3~113.9 s，旧代码必然 30 s 超时报"启动失败" | 正常等到就绪；Vite 真崩了 **1 003 ms** 就报错 | 修掉一个必现的假失败 |
| 6 | predev 其余项 | — | 见 §5 | **无可安全缩短项**（原计划的 `-v:q` 被证伪并回退）|

`npm run dev` 的冷启动总账（依赖缓存为空，即新克隆 / 清过 `.vite` 的情形；
"可用"定义为依赖预构建完成、`deps/_metadata.json` 落盘）：

| | 改前 | 改后 |
|---|---|---|
| predev（改后 `npm run predev` 实测 8.16 s；改前含旧 guard 5.4 s、改后 guard 0.3 s） | **≈ 13.2 s** | **≈ 8.1 s** |
| Vite 到依赖缓存可用（`_metadata.json`） | **63.4 s** | **19.2 s** |
| **合计（冷启动）** | **≈ 76.6 s** | **≈ 27.3 s** |

即冷启动 **从 76 秒降到 27 秒（省约 49 s，-64%）**。
（更早的几次基线更差：`metaAt` 到过 92 s 以上，合计 100 s+。）

predev 那 8.1 s 里有 5.8 s 是 `dev:tools` 的 dotnet build，本轮**没有**缩短它（原因见 §5，
唯一想到的 `-v:q` 是假的、会直接让 predev 失败）。所以这 8.1 s 是"没动过"的固定开销。

注意 `Scan completed`（10.2 s）之后还有一段 esbuild 预构建/写盘，所以到 `_metadata.json`
是 19.2 s；TCP listen 在这之前 1.6 s 就已经可以连上了。

## 1. 根因：`apps/desktop` 目录里有 1483 个 html

```
apps/desktop/release/   2.8 GB   27 417 个文件，其中 1 112 个 .html（electron-builder 产物：linux-unpacked / win-unpacked / LICENSES.chromium.html）
apps/desktop/runtime/   424 MB    9 050 个文件，其中   370 个 .html（含 PortableGit 的 doc/*.html）
apps/desktop/dist/       26 MB                  1 个 .html（outDir，已被 Vite 默认 ignore）
apps/desktop/index.html                         1 个 —— 真正的入口
```

扫描入口数正好对上：`1 + 1112 + 370 = 1483`。

Vite 两处默认行为会把它们全部吃进去：

1. `optimizeDeps.entries` 默认是 `**/*.html`。这 1483 个 html 全部被当成依赖扫描入口，
   esbuild 要逐个 crawl 一遍。日志里能直接看到：

   ```
   vite:deps Crawling dependencies using entries:
     C:/git/agent/TinadecOffice/apps/desktop/index.html
     C:/git/agent/TinadecOffice/apps/desktop/release/linux-unpacked/LICENSES.chromium.html
     C:/git/agent/TinadecOffice/apps/desktop/release/win-unpacked/LICENSES.chromium.html
     C:/git/agent/TinadecOffice/apps/desktop/runtime/git/mingw64/share/doc/connect/manual.html
     ...
   ```

2. `server.watch` 的 chokidar 会从 project root 往下爬。Vite 的默认 ignore 列表里
   **已经**有 `**/.git/**`、`**/node_modules/**`、`**/test-results/**`、`<cacheDir>/**`
   以及 `emptyOutDir` 时的 outDir glob（详见 §6），但**没有** `release/` 和 `runtime/`。

两者叠加，冷启动时有 **36 467 个文件**要 chokidar 爬（27 417 + 9 050）、1483 个 html 要 esbuild 解析，和 CPU/IO 互相抢。

## 2. 三个数字组（`watch.ignored` / `optimizeDeps.entries` 分别贡献多少）

固定 harness `tmp/perf/vite-cold.mjs`：每次 `rm -rf` 独立 cacheDir 起一个全新 Vite，
`DEBUG=vite:deps` 取 `Scan completed in Xms`，HTTP 轮询等 listen。全部在端口 5290。

| 组 | harness flags | 扫描入口数 | `Scan completed` | 次数 |
|---|---|---|---|---|
| 改前（as-is） | — | 1483 | **113 892 / 93 718 / 107 605 / 59 322 / 54 273 ms** | 5 |
| 只加 `optimizeDeps.entries` | `--entries` | 1 | **99 237 / 92 498 ms** | 2 |
| 只加 `watch.ignored` | `--ignore-watch` | 1483 | **28 502 ms** | 1 |
| 两者都加（= 最终改动） | `--entries --ignore-watch` | 1 | **24 069 / 39 237 ms** | 2 |

读法（这一条很重要，别读反了）：

- **`optimizeDeps.entries` 单独加，没有可测收益**：92~99 s 与改前 54~114 s 的区间完全重叠。
  因为扫描入口数从 1483 降到 1 只省掉 esbuild 的 crawl，真正的大头是 chokidar 在爬
  `release/` + `runtime/` 那 3.6 万个文件；只要 watch 还在爬，扫描照样要排队等 IO。
- **`watch.ignored` 才是收益来源**：只加它一次就掉到 28.5 s；它前后最近的两次改前基线
  是 113.9 s（04:53）和 93.7 s（05:01），它跑在 04:59。
- 两者都加 24.1~39.2 s，与只加 `watch.ignored` 同量级。`optimizeDeps.entries` 的价值在于
  **语义正确**（入口本来就只有一个）以及把 1482 个无关 html 从扫描里摘掉，
  它自己不是时间来源。
- 注意 `watch.ignored` 那一格只跑了 1 次（不是 2 次），样本少；但 §3 的背靠背 A/B
  独立复现了同样的量级，所以结论不是单点。

## 3. 最终 A/B：改前 config 快照 vs 工作树 config

harness `tmp/perf/final-ab.mjs`（`node tmp/perf/final-ab.mjs <rounds> <warmRuns> [cells]`）：
"改前"用 `tmp/perf/vite.config.snapshot.ts`（已 `diff` 确认与 `HEAD:apps/desktop/vite.config.ts` 逐字节相同），
"改后"直接读工作树文件。两个 cell 加**完全相同**的测量用覆盖（独立 cacheDir + 端口 5296），
所以差异只来自我的改动。冷启动前 `rm -rf` cacheDir。

```bash
node tmp/perf/final-ab.mjs 1 2 before after
```

| 指标 | 改前 | 改后 |
|---|---|---|
| 依赖扫描入口数 | 1483 | **1** |
| `Scan completed` | **54 273 ms** | **10 209 ms**（另一次被无关 EBUSY 干扰：25 540 ms） |
| listen（TCP 可连） | 1 862 ms | 1 644 ms |
| `deps/_metadata.json` 落盘 | **63 359 ms** | **19 152 ms** |
| MCP 行 | 有 | 无 |

同一 driver、背靠背、同机，这一组是本次最干净的对照：
**冷启动依赖扫描 54.3 s → 10.2 s（省 44.1 s，-81%）**，
到依赖缓存可用的 63.4 s → 19.2 s（省 44.2 s）。

warm（依赖 cache 已存在、Vite 直接跳过扫描）**理论上不受影响**，实测也确实如此：

| warm 指标 | 改前 | 改后 |
|---|---|---|
| listen（TCP 可连） | 2 196 / 1 364 ms | 1 644 / 1 660 / 1 573 ms |
| `GET /`（首屏 HTML 转换） | 21.7 s | 16.1 / 19.8 s |
| listen+GET / + main + App 合计 | — | 17 718 / 21 531 ms |

> **这张表只能当方向性参考**：改前的 `GET /` 来自另一轮 `vite-warm.mjs` 测量，
> 不是同一次 final-ab 的 before cell（那次 before cell 的 warm 只记了 listen）。
> warm 的 `GET /` 是 Vue SFC 全量编译，属 renderer 侧，不归这次改动管；
> 3~5 s 的差在噪声范围内（见开头机器说明），**不要当成收益**。
> 真正的结论是：改动只影响"第一次扫描"，warm 没有回归。

## 4. `dev-port-guard.mjs`：5.4 s → 0.3 s

原实现：每次 `npm run dev` 无条件跑一次

```
powershell -NoProfile -NonInteractive -Command "Get-NetTCPConnection ... | Get-CimInstance Win32_Process ... | ConvertTo-Json"
```

拉起一个 Windows PowerShell 5 进程并逐端口查 CIM。单独测这条命令：

```
ps-query run1: 5089 ms
ps-query run2: 2951 ms
ps-query run3: 2941 ms
```

而 `netstat -ano -p TCP`（读一遍全表）：**154 / 144 / 147 ms**。

### 改法

先 netstat 读一遍端口表：

- 三个**服务**端口（48730/48731/5173）都没人监听 ⇒ 直接 `exit 0`，**不拉 PowerShell**。
- 有人监听 ⇒ 回落到原来那段 PowerShell 判归属，逻辑一行未改。
- netstat 不可用 / 输出解析不出来 ⇒ 同样回落（`listeningDevPorts()` 返回 `null`），
  所以"省时间"永远不会变成"漏检"。

新增 `BLOCKING_PORTS = [48730, 48731, 5173]`，与 `PORTS = [48730, 48731, 5173, 9222]` 分离。

### 9222 这个边界

9222 是 Electron DevTools 端口，不是服务监听端口：被占着**不会**让 dev 启动失败，
只影响 DevTools 能不能连上。它原本会让"是否有残留进程"的判断永远为真（开发者机器上
9222 很常见被占），从而让快速路径形同虚设。现在的处理：

- 不参与"要不要走完整检查"的判断（不在 `BLOCKING_PORTS` 里）；
- 但被占时**仍然打印一行提示**（"端口 9222（Electron DevTools）已被占用，不影响 dev 启动，跳过检查"），
  然后 `exit 0`——不为了它拉一次 PowerShell。
- 如果 9222 被仓库外的进程占着、而这次确实走到了完整路径，则走 `advisory` 数组只提示不阻塞，
  不像其它端口的 foreign 监听者那样 `exit 1`。

### 数字

| 场景 | 耗时 | 结果 |
|---|---|---|
| 改前基线 | **5 384 ms** | 每次都跑 PowerShell |
| 四端口全空（本机 3 次） | **267 / 295 / 349 ms** | 快速路径 exit 0 |
| 四端口全空（Lead 复核 3 次） | **327 / 293 / 300 ms** | 同上 |
| 9222 被占、三服务端口空闲（Lead 复核 2 次） | **285 / 279 ms** | 打印 9222 提示后 exit 0 |
| 9222 被占 + netstat 核对确认 LISTENING（Lead 复核） | **298 ms** | 同上 |
| 5173 被外部 node 占用 + `report` 模式（Lead 复核） | 走完整路径 | 正确报出 `端口 5173 <- node.exe (pid X)` 并 exit 1 |

**收益：每次 `npm run dev` 约省 5.1 s。**

### 隔离仿真（不碰真实端口）

`tmp/perf/sim-guard-isolated.mjs`：把 guard 复制一份，把 PORTS/BLOCKING_PORTS/PORT_LABELS/9222
字面量重映射到 5301-5304，并在 PATH 前面放一个假的 `powershell.cmd`（记录调用并回 `FAKE_PS_JSON`）。
这样能测"有没有拉起 PowerShell"和分支走向，而完全不碰 48730/48731/5173/9222。

| 场景 | 耗时 | exit | 是否拉起 PowerShell |
|---|---|---|---|
| A 四个端口都没人监听 | 224 ms | 0 | 否 |
| B 只有 DevTools 口被占 | 214 ms | 0 | 否（打印 advisory） |
| C 有阻塞端口被占 | 3 600~4 400 ms | 1 | 是（foreign 监听者被报出） |
| D 同上，换一种占用 | 3 600~4 400 ms | 1 | 是 |

### 归属判定不回归

`isOwnDevProcess()` 一行未改，但为了确认快速路径没让它被绕过，用 `tmp/perf/test-ownership.mjs`
把它单独抽出来做表驱动测试（8/8 全过）：自己仓库的 `TinadecCore.Api.exe`、
`bun --watch src/index.ts`（含反斜杠路径）、仓库内 `node`/`electron` → `true`；
仓库外 `node`、不带 `--watch` 的 `bun` → `false`。

> 记账：真实端口上只跑过 `TINADEC_DEV_PORT_GUARD=report`，没跑过回收路径。
> 早期一次误跑真 guard 曾结束掉 Lead 在 48731 上的 `TinadecCore.Api.exe`，此后一律隔离仿真。

## 5. `predev` 各项开销

`"predev": "node scripts/check-dependencies.mjs && node scripts/dev-port-guard.mjs && node scripts/setup-shadcn-ai.mjs && node scripts/setup-ripgrep.mjs && npm run dev:tools"`

| 步骤 | 耗时 | 结论 |
|---|---|---|
| `check-dependencies.mjs` | 386 / 528 ms | 只读，留着 |
| `dev-port-guard.mjs` | **5 384 → 267~349 ms** | 本次改动，见 §4 |
| `setup-shadcn-ai.mjs` | 301 / 355 ms | 留着 |
| `setup-ripgrep.mjs` | 254 / 299 ms | 留着 |
| `dev:tools`（dotnet build TinadecTools） | 4.2~7.3 s | 见下，**没有安全的缩短办法** |
| `npm run predev` 合计，**改后**（含 npm 自身开销） | **8 160 ms** | 改前 = 8 160 + (5 384 − 300) ≈ **13.2 s** |

### `dev:tools` 的 `-v:q`：**被证伪，已回退**

原本想把 `"dev:tools"` 改成带 `-v:q -nologo`。第一次测得 5 007 ms → 1 903 ms 就写进了计划，
**这个数字是假的**：那 1 903 ms 量的是失败路径。

`scripts/dotnet.mjs` 在 Windows 上不是直接调 `dotnet`，而是

```
pwsh.exe -NoProfile -ExecutionPolicy Bypass -File scripts/setup-dotnet-env.ps1 <args...>
```

而 `setup-dotnet-env.ps1` 的参数是 `[Parameter(ValueFromRemainingArguments = $true)][string[]]$DotnetArgs`。
PowerShell 会先把 `-v:q` 当成**自己**的参数去绑（`-v` 是 `-Verbose` 的前缀），于是：

```
setup-dotnet-env.ps1: 无法将 'System.String' 转换为类型 'Verbose' 的参数 'System.Management.Automation.SwitchParameter'
exit code 1
```

实测 `node scripts/dotnet.mjs build TinadecTools/TinadecTools.csproj -v:q` → **exit 1，2 647 ms**。
如果就这么提交，`npm run dev` 的 predev 会直接断掉。已回退，`package.json` 的 `dev:tools` 保持原样。

能通过 PowerShell 绑定、并且确实传到 dotnet 的写法（`--verbosity:quiet` / `-verbosity quiet` /
`--verbosity quiet`）交错测了 3 对：

```
pair1 baseline: 7142 ms   quiet: 11648 ms
pair2 baseline: 7160 ms   quiet: 7190 ms
pair3 baseline: 5562 ms   quiet: 5600 ms
```

**没有收益**（quiet 只是少打几行日志，dotnet build 的 2.6 s 一点没少），所以不做。

`dev:tools` 的 5.8 s 是这么构成的：`dotnet build` 本体 2.6 s + **两次** pwsh 启动
（`dotnet.mjs` 先用 `spawnSync("pwsh.exe", ["-NoProfile","-Command","exit 0"])` 探一下 pwsh 在不在，
再起一次真正跑脚本；单次 pwsh 启动本机 0.7~2.3 s）。这条可以优化（去掉探测、直接用 `pwsh.exe`），
但属于"改共享启动器 + 需要验证 pwsh 不存在的回落"，本轮**未做**，留给后续。

## 6. 被证伪的假设：`optimizeDeps.include`（别重复踩）

**假设**：首屏加载时会看到 `new dependencies optimized: ...` 触发整页 reload，
把热门依赖（vue / vue-router / pinia / reka-ui / monaco / mermaid …）预先写进
`optimizeDeps.include` 就能免掉这波"发现新依赖 → 重优化 → reload"。

**实测**：`optimizeWaves = 0`，`pageReloads = 0`。

```
baseline.summary.json : { "optimizeWaves": 0, "optimizedModules": [], "pageReloads": 0 }
no-mcp.summary.json   : { "optimizeWaves": 0, "optimizedModules": [], "pageReloads": 0 }
```

也就是说**根本不存在第二波优化**——一次扫描就把所有依赖认全了，首屏没有 reload。
优化器脚本 `tmp/perf/vite-cold.mjs --includes` 已经写好但**没有跑**，因为没有可省的波次。

真正的成本是"第一波扫描本身要处理 1483 个入口 + chokidar 爬 3 万个文件"，
不是"波次太多"。所以 `include` 列表加得再全也不解决问题；
`optimizeDeps.include` 保持原样（只有 `@xterm/xterm`、`@xterm/addon-fit`、`@xterm/addon-web-links` 三项，未改）。

同理，Vite 的默认 ignore 列表里**已经**有 `**/node_modules/**`——不需要我们再写一遍。
（读 `vite/dist/node/chunks/*` 的 `resolveChokidarOptions()` 确认：默认值包含
`**/.git/**`、`**/node_modules/**`、`**/test-results/**`、`<cacheDir>/**`，
以及 `emptyOutDir` 为真时的 outDir glob。缺的只有 `release/` 和 `runtime/`。）

## 7. `waitForVite` 30 s → 180 s（含快速失败）

`apps/desktop/scripts/dev.mjs` 原来：

```js
const maxAttempts = 30;   // 每秒一次 ⇒ 30 s 硬上限
if (attempts > maxAttempts) reject("Vite dev server did not start within 30 seconds");
```

改前配置下冷启动实测 54.3~113.9 s（见 §2），**旧代码必然在 30 s 超时**，把一个还在正常
扫描的 Vite 当成失败处理——这本身就是冷启动体验的一部分（"等 30 秒然后报错"）。

改成 180 s 上限 + 每秒检查 `viteProcess.exitCode`：
真正的"起不来"（Vite 自己退出了）仍然立刻报错，不会傻等 180 s。

> **诚实的补充**：§2 的扫描修复落地后，这台机器上冷启动降到 19.2 s，已经低于 30 s，
> 所以在当前配置下这个 30 s 上限**不会再被触发**。这条改动的价值在于兜底：
> 更慢的机器 / 冷 cache 叠加首次 npm 安装后编译（`optimizeDeps` 全量重建）仍可能超过 30 s，
> 那时不该报"启动失败"。它本身**不贡献**本轮的秒数收益，属于"顺带修掉的假失败"。

**反向验证**（`tmp/perf/probe-reverse.mjs`，把 `waitForVite` 抽出来喂一个立刻
`process.exit(3)` 的假子进程）：

```
msToReject: 1003 ms
error: "Vite dev server exited before it started listening (exit code 3)"
```

（`exitCode` 在子进程退出后 **82 ms** 内就变成非 null，每秒轮询一次，所以 1 s 量级报错。）

## 8. VueMcp 默认关闭

`vite-plugin-vue-mcp` 原来无条件挂在 `plugins` 里。它每次启动会：

- 起一个本地 SSE 服务（`➜ MCP: Server is running at http://.../__mcp/sse`）；
- 往 index.html 注入一个 overlay 模块，连带把 `@vue/devtools-kit` 一整套拉进依赖图。

日常开发用不到。改成默认关闭，`TINADEC_VUE_MCP=1`（或 `true`/`yes`）时再挂：

```ts
const vueMcpEnabled = ['1', 'true', 'yes'].includes((process.env.TINADEC_VUE_MCP ?? '').trim().toLowerCase());
plugins: [vue(), tailwindcss(), ...(vueMcpEnabled ? [VueMcp()] : [])],
```

同一 harness、同日、单次执行的粗测（`vite-cold.mjs` 的 `--no-mcp` cell 只摘掉这个插件）：

| 指标 | MCP on（baseline） | MCP off（no-mcp） |
|---|---|---|
| 冷启动到 listen | 38 102 ms | 33 480 ms |
| 首屏整载 wall | 114 892 ms | 85 454 ms |
| 第二载（cache 有）wall | 6 034 ms | 3 992 ms |
| 请求数 | 492 | 482 |

各 1 次、这台机器抖动很大，**只能当方向性证据**：关掉确实是更轻的（少 10 个请求、
少了 devtools-kit 的编译）。回归时要开：`TINADEC_VUE_MCP=1 npm run dev`。

## 9. 改动清单

```
apps/desktop/vite.config.ts        17 +/ 2 -   watch.ignored + optimizeDeps.entries + VueMcp 默认关
apps/desktop/scripts/dev.mjs       13 +/ 6 -   waitForVite 180s + 快速失败
scripts/dev-port-guard.mjs         39 +/ 0 -   netstat 快速路径 + 9222 边界
package.json                       0 行改动（-v:q 试过又回退了；工作树里 allowScripts 那 3+/1- 不是本轮的）
```

三个文件都是 CRLF 行尾 + EOF 换行，`node --check` 通过。
`scripts/dev-port-guard.mjs` 属于"超出 dev 构建范围但由 Lead 授权"的改动（它是 `npm run dev` 的固定开销）。

## 10. 没做的 / 没测到的

- **`dev:tools` 的两次 pwsh 启动没优化**：可以去掉 `dotnet.mjs` 里那次 `pwsh exit 0` 探测，
  估计省 0.7~2.3 s，但要处理"pwsh 不存在时回落 powershell.exe"的验证，本轮没做。
- **`optimizeDeps.entries` 与 `watch.ignored` 的 warm 收益没测到**：warm 起点本来就
  cache 命中、不扫描，理论上为零，符合预期。
- **真正的"首屏可用"时间没测**：本轮所有数字都停在 "Vite listen / 依赖缓存落盘 / HTTP 200"，
  没有拉起 Electron 量 shell 可见。首屏 16~26 s 的 `GET /` 是 Vue SFC 编译，
  属 renderer 侧，本轮范围外。
- **`release/` 与 `runtime/` 为什么在 `apps/desktop` 下面**：这是打包/运行时目录布局问题，
  根治办法是挪到仓库根或 `outDir` 之外，但牵动 electron-builder 配置和运行时路径，未做。
  本轮的 `watch.ignored` + `entries` 是"不搬东西"的最小改动。
- **噪声**：全部测量期间机器上有其他 agent 在跑构建，8 核争抢严重。有一次"改后"冷启动
  撞上另一个 agent 编辑器临时目录造成的
  `EBUSY: resource busy or locked, watch '...\src\.i18n.ts.3204.*.tmpdir\i18n.ts.tmp'`，
  那次扫描 25 540 ms（不是本次改动引起的）。`logs/final-after-cold.log` 存的是重跑后的
  干净版本（10 209 ms，无 EBUSY）；25 540 ms 那次只作为"噪声能有多大"的记录保留在本文里。

## 11. 复现

harness 源码已复制到本目录 `harness/`，各 cell 的原始日志/JSON 在 `logs/`。
仓库内 `tmp/perf/`（gitignore）里是同一份在用的副本：

```bash
# 改前 vs 改后（冷启动 + warm），最干净的一组
node tmp/perf/final-ab.mjs 1 2 before after

# 单 cell 冷启动，可叠加 --entries / --ignore-watch / --no-mcp / --includes
node tmp/perf/vite-cold.mjs <label> <cacheDir> <port> [--entries] [--ignore-watch] [--no-mcp]

# guard 隔离仿真（假 powershell + 重映射端口，不碰真实端口）
node tmp/perf/sim-guard-isolated.mjs

# waitForVite 反向验证（立刻退出的假 Vite）
node tmp/perf/probe-reverse.mjs

# 归属判定表驱动测试
node tmp/perf/test-ownership.mjs

# 解析所有已存日志
node tmp/perf/parse-logs.mjs
```

原始 Vite 日志（`DEBUG=vite:deps`，含完整的 entry 列表）在本目录 `logs/` 下。
`harness/vite.config.snapshot.ts` 是"改前"配置快照，已 `diff` 确认与 `HEAD:apps/desktop/vite.config.ts` 逐字节一致。

## 12. 配置生效性验证（不是靠读代码，是真加载）

用 `vite` 自己的 `loadConfigFromFile()` 真加载 `apps/desktop/vite.config.ts`，
打印解析后的最终值（`tmp/perf/verify-config.mjs`）：

```
optimizeDeps.entries = ["index.html"]
server.watch.ignored = ["**/release/**","**/runtime/**","**/dist/**"]
plugins = vite:vue                         ← 默认，VueMcp 不在
mcp enabled by default = false
```

`TINADEC_VUE_MCP` 四种取值的实测：

| 环境变量 | 解析出的 plugins | MCP 是否挂上 |
|---|---|---|
| （未设） | `vite:vue` | 否 |
| `=1` | `vite:vue, vite-plugin-mcp` | **是** |
| `=true` | `vite:vue, vite-plugin-mcp` | **是** |
| `=0` | `vite:vue` | 否 |

`tailwindcss()` 返回的是一个 3 元素插件数组（`@tailwindcss/vite:scan`、
`@tailwindcss/vite:generate:serve`、`@tailwindcss/vite:generate:build`），
所以上面的列表没展开它——但确认它没被条件展开的写法弄丢。

## 13. 回归验证步骤

1. 清掉依赖缓存：`rm -rf apps/desktop/node_modules/.vite`
2. `TINADEC_DEV_PORT_GUARD=report npm run dev`
3. 期望：`[dev-port-guard]` 在 1 s 内返回（没有端口占用时不出现）；
   Vite 日志里 `Crawling dependencies using entries:` 下面**只有 `apps/desktop/index.html` 一行**；
   `Scan completed in` 应为 10~40 s 量级（机器空闲时更低），不再是 60 s 以上；
   全程不应出现 `EFBIG`/`EBUSY` 之外的报错，也不应出现 `page reload`（说明没有第二波优化）。
