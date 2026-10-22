# 界面文案规范（UIUX Text）

本规范约束用户能看到的每一句文字。违反「硬约束」会直接导致测试失败或界面渲染出键名；其余各条由评审把关。

## 1 适用范围

**属于本规范**：`apps/desktop/src/locales/{zh-CN,en,zh-TW,ja,ru}.ts` 的全部值；`electron/tray.cjs` 的 `TRAY_STRINGS`；模板里的 `title` / `aria-label` / `placeholder`；通知、错误提示、空态、按钮与页签标题。

**不属于**（不要按本规范改）：Core 返回的诊断原文、日志、代码注释、测试夹具、`agentPacks` 与 prompt 文本、`docs/` 下的文档、`debug/preview/mockData.ts`。

## 2 判定规则

**唯一判据**：删掉这句话，用户在这一屏会少知道什么、或少做一个动作？答不出来就删。

| # | 规则 |
|---|---|
| R1 | 只写新增信息、必要的行动请求，以及理解它需要的最少上下文。 |
| R2 | 不复述规则、历史、已确认事实，也不复述仅为让读者理解而提供的背景。 |
| R3 | 不用「结论」「原因分析」「说明」「为什么这样做」式标题。字段标签（`说明`、`评估说明`）不受此限。 |
| R4 | 一个已知事实不单独占标题、区块或页面。 |
| R5 | 不为「完整」「礼貌」「专业感」「模板感」扩写。短是默认值。 |
| R6 | 同一含义不写第二遍：同卡片内、跨键、跨面板都算。 |

**允许保留的例外**：一句直接服务于当前判断或动作的短上下文，即使读者理论上已经知道，也保留。判断依据是「这句话是否服务于当前信息、请求、判断或动作」，不是「它是否属于背景」。

## 3 反模式

- **辩解句**：为设计决策辩护，例如「这是设计决策而非配置错误」。
- **免责声明堆叠**：连续两句以上说明「本检测不保证 X」「不能证明 Y」，用户无法据此行动。
- **一卡多段说明**：一张卡片挂十余条解释性 hint，标签本身已经说明含义。
- **同一意思多键**：同一条消息在横幅、状态原因、快捷提示里各写一份，且措辞互不一致。
- **按钮旁解释按钮**：「点击『扫描服务』自动列出后端」。
- **实现细节外泄**：把 Revision 并发标记、ETag 校验、有界静默窗口讲给用户。
- **自述式小标题**：`说明` / `概览` / `背景` 作为区块标题，而非字段标签。
- **指向性废话**：「这里显示当前有效值与来源」——用户看得见。

## 4 仓库硬约束

违反任一条即为坏：

1. 界面文字只能来自键。模板里的中文字面量会被 `i18nParity.test.ts` 拒绝。
2. 增删键必须五语同步：`zh-CN` / `en` / `zh-TW` / `ja` / `ru`。
3. 占位符 `{name}` 集合必须与 `en` 完全一致：不能加，不能漏。
4. 复数 `|` 数量不可变：`en` 多形时 `ru` 恰好 3 形（one | few | many），其余语言恰好 1 形。
5. `settings.*` 的以下 19 个键必须保持**行首 4 空格**，且这些键所在行不得新增兄弟键：
   `centerCli` `centerTui` `centerAcp` `channelCli` `channelTui` `channelAcp` `quickConnectChannel` `channelNotDrivable` `channelNotDrivableDefault` `acpPermissionWarning` `tuiRuntimeHint` `noTuiRuntimes` `tuiBackendUnavailable` `harnessProviderInstance` `protocolUnknown` `protocolAcp` `protocolOpencodeServe` `protocolHeadlessCli` `protocolTui`
6. `settings.acpPermissionWarning` 与 `settings.tuiBackendUnavailable` 不可删除，且必须仍渲染在 ACP / TUI 面板内。
7. 本仓库 locale 文件为 **CRLF**；`zh-CN` / `en` 用单引号，`zh-TW` / `ja` / `ru` 用双引号。替换文案不得包含该文件自身的引号字符。

## 5 改动流程

**只改文案**：定位键 → 五语同改 → 跑 `npx vitest run src/locales/i18nParity.test.ts src/pages/SettingsPage.smoke.test.ts --pool=threads` → 跑该面板的组件测试。

**删除键**（顺序不可颠倒）：

1. 全路径检索：`grep -rn "<full.key.path>" apps/desktop/src apps/desktop/electron apps/TinadecUI/src`
2. 末段检索：`grep -rn "<lastSegment>" apps/desktop/src apps/TinadecUI/src`。末段命中而全路径未命中，说明键由字符串拼接而成——**禁止删除**，先读那处代码。
3. 命中第 6 节的动态家族或第 4 节的受钉清单——**不删**。
4. 五语删除该键，同时删掉模板引用，并同步修改因此变红的断言。

**注意**：`SettingsPage.vue` 不在 `i18nParity` 的 `panelSources` 里，删它引用的键时测试可能全绿，而运行时渲染出 `settings.xxx` 字面量。第 1 步的检索是唯一保险，不能靠跑测试兜底。

## 6 附录：动态键家族（禁止单独删除）

值由运行时枚举驱动，删除后会在某个分支渲染出键名。

`settings.personalRole_` · `settings.gatewaySource_` · `settings.serviceMode.` · `settings.petKind.` · `toolsSettings.programStatus.` · `toolsSettings.connectionStatus.` · `toolsSettings.tabs.` · `toolsSettings.diagnostic.` · `agentCenter.filter.` · `agentPack.status.` · `approval.kind.` · `approval.gates.status.` · `orchestrationPanel.layer.` · `orchestrationPanel.tier.` · `statusLabels.*` · `memory.status` · `memory.scope` · `memory.kind` · `debugStudio.preview.items.` · `debugStudio.scenario.` · `storage.categoryName.` · `storage.hostSource.` · `tinaChat.role_` · `tinaChat.status_` · `tinaChat.pstatus_` · `code.tabMode.` · `activity.roles.` · `organization.verb.*`（由 Core 的 `ProposedVerbs` 生成，`i18nParity.test.ts` 直接断言）
