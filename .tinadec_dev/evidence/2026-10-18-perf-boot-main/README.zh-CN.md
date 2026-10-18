# Electron 主进程启动：白屏修复

**日期：** 2026-10-18
**负责人：** lead
**范围：** 应用启动（用户报告"应用界面的加载"慢）

## 根因：窗口创建被排在整条后端启动链之后

`apps/desktop/electron/main.cjs` 的 `app.whenReady()` 原本是：

```js
const initialHost = await hostConnection.start();   // ← 阻塞点
...
await createWindow();                                // ← 窗口在这之后才存在
```

`hostConnection.start()` 内部会跑 `ensureLocalServices()`：探测 Core/Gateway 健康、校验 HMAC 身份、
启动缺失的子进程并**轮询等它们就绪**（`startupTimeoutMs = 90_000`，打包态 `verificationTimeoutMs = 200_000`）。

也就是说：**窗口是在后端完全启动之后才被创建的。** 在窗口出现之前，用户看到的是桌面，
不是应用——没有任何 splash、没有任何进度提示，因为渲染进程根本还没启动。

### 实测（本机，Release 构建，storage scopes 开启）

| 阶段 | 耗时 |
|---|---|
| Core 可执行文件到 /health 200 | **11.7–13.0s** |
| Gateway 冷启动 | 1.2–1.6s |
| 首个业务请求（project scope 挂载） | 修复前 67.7s / 修复后 2.37s |

即使只看 Core，打包态首启也有 **11s 以上的完全空白**。加上 Gateway 与首次 scope 挂载，
"点开图标 → 看到界面" 在修复前可以到 **一分多钟**。用户描述的"应用界面加载非常慢"主要就是这段，
而不是渲染层的问题。

## 修复

`hostConnection.start()` 不再 `await`，改为保留 promise 并把结果报告挪到窗口创建之后：

```js
const hostStartup = hostConnection.start();   // 立刻返回，验证在后台继续
...
await createWindow();                          // 窗口马上出现，渲染进程开始加载
hostStartup.then((initialHost) => {            // 结果仍被报告，失败仍可经 Banner 重试
  if (initialHost?.error) console.error('[tinadec] local host unavailable:', initialHost.error.code);
}, (error) => console.error('[tinadec] local host verification failed:', error?.message ?? error));
```

## 为什么这是安全的（不是把等待挪了个位置）

1. **授权与窗口存在无关。** 业务请求放行看的是 `trustedHostReady`，它只在
   `publishHostStatus()` 里随 `snapshot.state === 'ready'` 翻转。`trustedHostRequests.cjs`
   的 `isManagedHost()` 对每个请求实时读这个标志——提前出现的窗口拿不到任何业务授权。
2. **渲染层本来就建模了"尚未验证"。** `useConnection` 的初始状态是 `connecting`，
   `App.vue` 用 `isConnecting` 让 splash 停住主界面，`HostAvailabilityBanner` 显示真实原因与重试。
   也就是说这条路径是**已经存在且已测试**的失败/降级路径，只是原先 dev 与打包态都很少走到它。
3. **重试语义不变。** 注释原文就是 "A temporary startup failure remains recoverable after the page opens"——
   失败后依然可以通过 Banner 的 retry 走 `hostConnection.retry()`。
4. **没有新增信任面。** 窗口创建顺序变化不改变 `registerTrustedHostWindow`（按窗口登记）、
   `isTrustedHostDocumentSender`（校验主 frame 文档）或 `webRequest` 注入条件。

## 验证

- `node --check apps/desktop/electron/main.cjs` 通过。
- `electron/appConfig.test.cjs` **11/11** 通过（该文件用 `vm.runInNewContext` 真实执行 `main.cjs`，
  所以主进程脚本级回归被覆盖）。
- `electron/hostConnection.test.cjs` **8/8**、`electron/serviceManager.test.cjs` **12/12** 通过。
- 新增 `electron/mainStartup.test.cjs`（已加入 `package.json` 的 `node --test` 清单）**1/1** 通过，
  它钉住四件事：`hostConnection.start()` 不被内联 await、验证在窗口创建**之前**启动、
  延迟结果仍被报告、业务授权仍跟随已验证状态。

## 未做 / 边界

- 没有在真实打包产物上跑完整的"冷启动到可见窗口"秒表（需要 electron-builder 产物与安装环境）。
  上表的分段耗时是直接测 Core/Gateway 进程得到的，不是打包冒烟。
- `ensureLocalServices` 自身的 90s×2 预算没有改小。窗口不再被它挡住，但后端真的起不来时，
  用户看到的仍是"连接中 → 超时 + Banner"，这是既有设计。
- 未改 `useConnection` 的 `CONNECTION_TIMEOUT_MS = 30_000`。
