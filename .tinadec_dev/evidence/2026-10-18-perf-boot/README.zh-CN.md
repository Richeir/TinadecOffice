# 2026-10-18 渲染层启动性能（boot-perf）

任务：渲染层启动性能——i18n 懒加载多语言、入口体积、重组件懒加载、启动门控。
本目录只放**我实测到的**数字与复现方式；没测到的、测不准的写在最末「未完成 / 边界」一节，不折算、不平均。

## 改了什么（4 个源文件 + 2 个测试）

| 文件 | 改动 |
| --- | --- |
| `apps/desktop/src/i18n.ts` | 只静态 import 默认语言 zh-CN；其余四包改为 `() => import(...)` 动态拆包。新增 `loadLocale()` / `ensureActiveLocale()` / `setInterfaceLocale()`（先 load 成功、再切 locale，失败保持原语言）。五个 locale 仍在一开始就注册（只种 `common.languageName`），因此 `availableLocales` 完整、启动期同步 `t()` 不抛。 |
| `apps/desktop/src/main.ts` | 非默认语言启动时首帧前 `await ensureActiveLocale()`（失败降级 zh-CN）；跨窗口 storage 监听改用 `setInterfaceLocale`（包到位才切）。 |
| `apps/desktop/src/settings/sections/GeneralSection.vue` | `setLocale` 先 `await setInterfaceLocale(lang)`，成功后才写 `localStorage`；失败不落盘。 |
| `apps/desktop/src/App.vue` | 主界面**不再等连接**：删掉 `mainStarted` / `isConnecting` 门控，`.main-content` 首帧即挂载；App setup 里把空 gate 发布成 `{state:"checking"}`，业务读取继续 fail-closed，且 `HostAvailabilityBanner` 在 connecting 期间可见。已发布的 gate（预览 shim 的 `preview`、主进程推送）不被覆盖。 |
| `apps/desktop/src/App.entry.test.ts` | 补三条不变量：splash 保持到 ready / connecting 期间主界面可挂载且 Banner 可见 / fail-closed 不变（12/12）。 |
| `apps/desktop/src/locales/i18nParity.test.ts` | 懒加载后补 `beforeAll` 预载全部语言包（8/8）。 |

## 数字一：入口体积（生产构建，vite build）

| | 改前 `index-Fjeluni6.js` | 改后 `index-YQZfJESZ.js` | 变化 |
| --- | --- | --- | --- |
| raw | 1,735,908 B（1,695 KB） | 814,050 B（795 KB） | **−921,858 B（−53%）** |
| gzip | 545,010 B（旧构建日志） | 275,120 B（我对产物 gzipSync 实测） | **−269,890 B（−50%）** |

四个非默认语言包变成独立 chunk（raw / gzip B）：`en` 184,433 / 59,074；`zh-TW` 178,560 / 64,568；`ja` 251,425 / 70,534；`ru` 309,917 / 78,741。

**注意收益的性质**：`dist` 总大小不变（204 个 JS，22,854,202 B raw）。收益是「首屏不必下载/解析用不到的语言」，**不是产物变小**，磁盘占用和分发体积没有下降。只有默认 zh-CN 用户拿到全部收益。

实测传输量（探针 Network 域，同一构建、同一份静态服务器）：改前 32 请求 / 3,850,881 B（JS 3,385,893）；改后 32 请求 / 2,928,572 B（JS 2,464,035）。CSS 两者完全相同（416,425 B）——即首屏除了入口 JS 变瘦，其它请求没变。

## 数字二：启动时序（headless Chrome 1400×900，冷 profile，CDP）

探针是我自己的副本 `tmp/perf/boot-perf/probe-boot.mjs`（**未改动**共享的 `tmp/perf/probe.mjs`）。共享探针把「还没出现 splash」误判成「splash 已离场」（基线里那个 55.7ms 的 `splashGone` 就是这么来的），我的副本把**出现 / 离场**分开计时，并额外计时 `.main-content`、shell、路由页、Banner。

### 组 1：默认 zh-CN 启动（大多数用户的实际路径）

| 指标 | 基线（04:30，`index-Fjeluni6.js`） | 改后（干净构建，n=9） |
| --- | --- | --- |
| FCP | 148 ms | 40 ms ~ 2,276 ms（中位 468） |
| splash 出现 | 未单独计时（旧探针无此字段） | 30 ms ~ 2,274 ms（中位 468） |
| splash 离场 | 55.7 ms（**旧探针误判**，见上） | 491 ms ~ 2,645 ms（中位 748） |
| `.main-content` 可见 | 444.5 ms | 234 ms ~ 2,274 ms（中位 468） |
| shell 可见 | 774.6 ms | 未单独取到（同 `.main-content` 同帧挂载） |
| 长任务总时长 | 539 ms | 349 ms ~ 1,122 ms（中位 382） |

**这张表不能当成 A/B。** 机器是共享的：测量期间另外两位 teammate 在跑 vite build 和 dev server，同一份构建同一批次的 FCP 从 40 ms 波动到 2,276 ms。唯一稳定、可复现的差异是**传输字节**（上一节）和**下面组 3 的结构性变化**；上面这些毫秒数的组内波动远大于组间差值，我不据此宣称启动变快。

> 关于「FCP 40 ms vs 基线 148 ms」：**这不是本次改动的效果，请不要写进结论。** 首帧画的是 `index.html` 里内联 CSS 的 `.splash-placeholder`，改前改后这段 HTML/CSS 逐字相同（探针里两者 CSS 传输量都是 416,425 B），结构上不可能差 3 倍；该差值只能归因于机器负载/磁盘缓存状态。测量次数不足，无法给出可信的 FCP 改善幅度。

### 组 2：主进程永不回状态（降级路径）——本次最硬的结构性收益

用 `--stub-host` 模拟 Electron 主进程的 `getHostStatus` 永不 resolve（改前 `App.vue` 的 `mainStarted` 正是等这个）。

| 指标 | 改前（源码语义） | 改后（实测） |
| --- | --- | --- |
| `.main-content` | **永不出现**：`mainStarted` 要等 `useConnection` 离开 `connecting`，而它 30 s 超时后才置 `timeout` | **490 ms** |
| 状态 Banner | 无（门控连 Banner 一起挡住） | **491 ms**，文案为 `hostBanner.checking` |
| splash 离场 | 一直挂着 | 788 ms |
| 控制台错误 | — | 0 |

这是「窗口不再等后端」改动最直接的用户可见效果：**后端卡死那条路径上，用户从「30 秒纯启动图」变成「约 0.5 秒看到界面 + 明确的连接中横幅」**。这一条不依赖机器负载，是代码门控变更的确定结果。

### 组 3：非默认语言启动（用体积换时间，必须单列）

| locale | FCP | `.main-content` | splash 离场 | 额外下载 |
| --- | --- | --- | --- | --- |
| `en`（n=12） | 36 ms ~ 416 ms（中位 196） | 196 ms ~ 524 ms（中位 384） | 461 ms ~ 810 ms（中位 728） | +184,433 B raw / +59,074 B gzip |
| `zh-TW`（n=1） | 452 ms | 587 ms | 935 ms | +178,560 B / +64,568 B |

非默认语言路径**比默认路径多下载一个 178~310 KB 的语言包**，且 `main.ts` 的首帧前 `await ensureActiveLocale()` 让这个下载落在首帧之前（这是刻意的：否则会先画一帧 zh-CN 再跳变）。en 组的 FCP 中位 196 ms 明显高于 zh-CN 最静的那几次（40 ms），方向与预期一致，但同样受负载影响，**只能定性说「非默认语言要等一个语言包」，不能给出可信的固定增量**。

**不要让这两条路径平均**：zh-CN 用户拿到全部字节收益；en/ja/ru/zh-TW 用户拿到的是「延迟换正确性」，ja/ru 更要下载 251/310 KB。

## 教训：`vite build` 期间改源文件会产出混合产物，而且文件名 hash 看起来完全正常

本次踩到：`apps/desktop/dist` 的 `index-DVs2JE-p.js` 里 `mainStarted` 出现 3 次，而同期的 `src/App.vue` 里已经是 0 次。原因是 Vite 在构建早期读到了旧 `App.vue`（build 05:39:19 开始 / App.vue 05:39:46 保存），`emptyOutDir` 拦不住这种情况。表现是：headless 打开后 DOM 里只有 splash + 命令面板，`.main-content` / `background-layer` / Banner 全都不存在，**但没有任何报错**。

检测办法（建议固化成习惯）：**构建后 grep 一个「改后应该消失的符号」**，例如

```bash
grep -c mainStarted apps/desktop/dist/assets/index-*.js   # 期望 0
```

或反向 grep 一个「改后才该出现」的符号（本次是 `host-availability-banner` / `setHostAccessStatus` 的 `checking`）。体积数字不受影响（i18n 部分 chunk hash 与干净构建逐一相同，入口只差 20 B），但**任何运行时/DOM 结论都必须来自确认过内容的产物**。

## 未完成 / 边界（如实记录）

1. **没有真实 Electron 打包态验证。** 全部数字来自 headless Chrome + 本地静态服务器（`--headless=new`，无 GPU、无 Electron 主进程、无 `app://bundle` 协议）。真实 Electron 里还有 preload、`app://` 协议、`backgroundColor` 与 `ready-to-show` 时序，`splash` 的绝对毫秒数会不同；组 2 的「改前永不出现」是从源码门控语义推出来的，不是跑旧包实测的（旧 `dist` 已被 `rm -rf`，`release/win-unpacked` 里的 asar 是 10-04 的旧版本，不能代表改前源码）。
2. **组 1 的毫秒数不可作为 A/B 结论**：共享机器上 3 个 teammate 并发跑构建/dev server，同构建 FCP 从 40 ms 波动到 2,276 ms。要拿到可信数字需要在安静机器上、两种构建交替各跑 ≥10 次取中位数。
3. **`shellVisibleMs` 没独立取到**（`.main-content` 与 shell 同帧挂载，探针的 `shell` 选择器命中的也是同一节点）；基线里的 774.6 ms 来自旧探针的 `.shell` 选择器，两者不可直接对比。
4. **非默认语言的 FCP 增量没有可信数值**（en n=12 中位 196 ms、最慢 416 ms，受负载影响）；只有「要多下载 178~310 KB 且这下载发生在首帧前」是确定的。ja / ru 未单独测（包更大，预期更慢）。
5. **重组件异步边界（xterm / `MarkdownRender` / `CommandPalette`）没有做。** 入口从 1,695 KB 降到 795 KB 后，剩余体积的大头已是首屏必需（Vue 运行时、路由、UI 基础组件、编辑器/终端相关），继续拆的收益没有测量支撑，未动手。
6. **`dist` 总大小未变**（26 M / 22.85 M JS），语言包仍然随包分发；这次只改变「首屏加载哪些」。

## 复现

```bash
# 干净构建到独立目录（不要写共享的 apps/desktop/dist，避免与其它 teammate 抢）
cd apps/desktop
NODE_OPTIONS=--max-old-space-size=8192 npx vite build --outDir ../../tmp/perf/boot-perf/dist-after --emptyOutDir
# 确认产物是新代码（期望 0 / 1 / 1）
grep -c mainStarted ../../tmp/perf/boot-perf/dist-after/assets/index-*.js

# 静态服务器 + 探针（--locale= 注入 localStorage，--stub-host 模拟主进程不回声）
node tmp/perf/boot-perf/static-server.mjs tmp/perf/boot-perf/dist-after 5202
node tmp/perf/boot-perf/probe-boot.mjs http://127.0.0.1:5202/
node tmp/perf/boot-perf/probe-boot.mjs http://127.0.0.1:5202/ --locale=en
node tmp/perf/boot-perf/probe-boot.mjs http://127.0.0.1:5202/ --stub-host
```

`summary.json` 是全部原始 run 的汇总（按 zh-CN / en / zh-TW / stub-host / baseline 分组，含 min/中位/max）；`probe-raw/` 下是每次运行的原始 JSON。
