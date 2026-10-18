# 平面对话流真实 Electron 验收（2026-10-18）

## 环境

- 工作区：`C:\git\agent\TinadecOffice`，分支 `main`，未提交工作树。
- 数据根：用户真实环境（未设置隔离 `TINADEC_HOME`）；实际项目 `C:\git\agent\RouterAPI`。
- Electron：真实 Electron 43、`--user-data-dir=C:\Users\lincu\.tinadec\state\desktop`，CDP `9222`。
- Core `48731`、Gateway `48730`、Vite `5173`；宿主 token 与 Core/Gateway challenge 双向校验通过。
- 启动过程中 `npm run dev` 的 `dotnet run` 两次卡在多个 MSBuild 节点；用 `dotnet build-server shutdown`、单节点预构建和 `--no-build` 恢复。此项是当前机器/工具链观察，未改 `.NET` 启动脚本。

## 真实故障与修复

### SSE 业务事件全断

`ScopedEventSource` 原来调用 `this.fetchImpl(...)`。Electron 的原生 `fetch` 是 Window 方法，被绑定到 `ScopedEventSource` 后抛：

```text
TypeError: Failed to execute 'fetch' on 'Window': Illegal invocation
```

错误被重连 catch 吞掉，所以只看到 heartbeat，模型、工具、监督事件全部不进对话流。修复为：

```ts
const fetchImpl = this.fetchImpl
const response = await fetchImpl(this.url, { ... })
```

回归测试 `scopedEventSource.test.ts` 使用普通函数注入，若按实例方法调用（`this === source`）即失败。

### 监督裁决

真实旧会话：

- session `4F9E63F7-8984-4798-93ED-08A4C939B5E8`
- run `B4B56D9A-2270-4BA1-994A-15895DD51F71`
- `awaiting_user`，496 个 durable 事件

修复后重开该会话，真实 Electron 显示：

- 三条原因原文；
- “继续 / 纠正 / 取消”三个可操作按钮；
- 之前的思考、子智能体、监督修改步骤仍在流中。

这说明裁决来自 reducer 的事件重放，旧的 `agentTurnActivities` 平行 map 不再是必要路径。

## 阶段步骤真实表现

真实模型 run：

- session `DE6AFAE8-1799-48BC-90C3-9F26955D5D55`
- run `D23B8B9C-968C-4E7D-9AB8-F7412C43A8E7`
- 状态 `completed`，26 个事件，完成于 `12:43:47Z`

Electron 实页观察到：

1. 发送后先显示“正在规划”，带列表图标；
2. 随后落成“正在思考 33 秒 / 正在思考 16 秒”和“正在起草…”，分别带思考/笔图标；
3. 完成后面板显示“已工作 1 分 9 秒”，答案 `状态步骤图标已显示。` 进入回答区；
4. 重开历史会话仍能读到答案，不依赖实时状态。

数据库回读 assistant message：

```text
角色: assistant
长度: 30
内容: 状态步骤图标已显示。
```

另一次真实 Team/worker run：

- session `0FC72DE9-C555-4C44-9C4D-AD3B856F11D7`
- run `EF6B3449-7FFE-492F-B2DD-AE3BEDBA1C0E`
- 46 个事件，`completed`
- answer：`平面模式状态流测试成功。`

该 run 之前因为 HMR 后宿主信任状态失效而让旧窗口停在“正在思考”，但 Core 已完成并落盘；清理 Electron 主进程并用实际用户 profile 重启后，历史答案正常显示。不要在开发中把 HMR 后旧 main 的宿主信任失败误判为模型或 Core 卡死。

## Vite 冷启动

清空依赖缓存后，默认 optimizer 在 UIE 循环 barrel 上不返回，`/src/main.ts` 请求超时。`vite.config.ts` 现在使用：

- `optimizeDeps.noDiscovery: true`
- 显式首屏依赖 `include`
- `holdUntilCrawlEnd: false`
- `ignoreOutdatedRequests: true`
- Monaco、Mermaid、Recharts、图标静态包等重依赖 `exclude`/按需

`highlight.js/lib/core` 必须单独 include，否则 Vite 直出 CJS 子路径时会报 `does not provide an export named 'default'`。

## 验证

| 检查 | 结果 |
|---|---|
| `vue-tsc --noEmit` | 通过 |
| SSE + supervision + phase + i18n 定向 | 34/34 通过 |
| `vite build` | 成功，6m38s；仅保留既有大 chunk 警告 |
| 真实 Electron 监督卡 | 通过 |
| 真实模型消息与回答 | 2 条均 completed，回答落盘并可重开 |

## 未验收

- macOS/Linux 真实 Electron；
- 安装包/打包态 `app://bundle`；
- Windows 低权限 ACL；
- HMR 后宿主信任恢复的产品级自动重启；开发时仍需整链重启。
