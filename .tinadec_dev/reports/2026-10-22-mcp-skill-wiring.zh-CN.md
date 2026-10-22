# MCP 与 Skill 架构前后贯通核查

日期：2026-10-22 · 范围：TinadecOffice 产品（Desktop → Gateway → Core → TinadecTools），不是开发工具侧的 MCP/Skill。
证据：源码 + 当前安装只读数据库/TOML + 本轮定向测试。命令与原始结果见
[`../evidence/2026-10-22-mcp-skill-wiring/verification.txt`](../evidence/2026-10-22-mcp-skill-wiring/verification.txt)，
安装授权快照见 [`../evidence/2026-10-22-mcp-skill-wiring/installed-agent-scopes.json`](../evidence/2026-10-22-mcp-skill-wiring/installed-agent-scopes.json)。

## 一句话结论

**管理面是通的，运行时注入也是通的，但“模型能用 MCP”这一环没有通。**
MCP 服务器/Skill 资源可以从 UI 建、可以冻进 run、Tools 也能真正握手和调用，
但 `meeting`（主对话身份）与 `solo_master` 的 `tool_scope` 里没有 `mcp_list/mcp_search/mcp_invoke`，
当前 GraphSeedPack 内 MCP 只授予 `search` 与 `artex_worker`
（安装库里另有测试 pack 的 `worker.browser/worker.code`，不属于当前模式）。
所以用户在 Solo/Plan/Review/Spec/Correction
里直接让助手用 MCP，模型根本看不到这三个工具；只有协调者主动派给 `search` 时才可能用到。

Skill 的运行时链路本身是通的（索引进 prompt、正文用 `read_file` 读），
但产品只发现 `<workspace>/.tinadec/skills`（两层深），且当前安装
`tool_mcp_resources`、`tool_skill_resources`、`~/.tinadec/skills` 全为空，
工作区没有 `.tinadec/skills`，技能资产放在 `.claude/skills`（链接到 `.tinadec_dev/skills`）。
因此从实机看，“配置了也没反应”是必然结果。

## 调用链与判定

```
Desktop Settings
  ToolCenterSection / ToolResourcesPanel
    └─ /api/v1/tools/mcp/servers, /tools/skills, /tools/settings/*
Gateway
  toolsSettingsRoutes.ts（薄代理，保留 If-Match/ETag/错误码）
  index.ts（两条 /api/v1/mcp/servers 读代理）
Core
  ToolSettingsEndpoints / ToolSkillEndpoints / McpEndpoints
  McpResourceRegistry / ToolSkillResourceService
  ToolConfigurationResolver → 冻结进 FrozenRunConfiguration
TinadecTools
  McpServerRepository（优先读执行上下文，文件配置仅独立模式）
  McpClientPool / mcp_list / mcp_search / mcp_invoke
模型
  FrozenToolManifestCatalog：AllowedTools（agent 版本 tool_scope）∩ 冻结 manifest
  上下文：ContextModuleRegistrar 的 skill 索引
```

| 环节 | 判定 | 证据 |
| --- | --- | --- |
| 设置页 → Gateway → Core 的 MCP/Skill 管理面 | 通 | `TinadecGateway/src/toolsSettingsRoutes.ts:39-59`；`ToolSettingsEndpoints.cs:81-105`；`ToolSkillEndpoints.cs:10-63` |
| MCP/Skill 资源持久化与审批 | 通 | `McpResourceRegistry.cs:15-91`；`ToolSkillResourceService.cs:150-224`；`MarketInstallService.cs:469-505` |
| run 准入冻结 MCP 服务器与 Skill 快照 | 通 | `ToolConfigurationResolver.cs:25-106,108-155`；`FrozenRunConfiguration.cs:503-520` |
| Tools 宿主按冻结上下文连 MCP | 通 | `McpServerRepository.cs:21`；`McpClientPool.cs:105-121`；真实 Node stdio 测试 8/8 |
| Skill 索引进入 prompt、正文留给文件工具 | 通 | `ContextModuleRegistrar.cs:444-475`；`WorkspaceSkillApiTests` 26 例；`FullDuplexEndpointTests.cs:754` |
| **主对话智能体的模型工具面包含 MCP** | **断** | 安装库：`meeting` 37 工具、`mcp_*` 0；`search` 19 工具、含 `mcp_*` |
| **UI 能给内置智能体补授 MCP 工具** | **断** | `SettingsPage.vue:1252`（`is_built_in`），`3494-3512`（工具编辑禁用，只能克隆） |
| **Skill 发现覆盖常见目录布局** | **窄** | `WorkspaceSkillPolicy.cs:47`：只认 `.tinadec/skills` |
| **当前安装有可验证的资源** | **无** | `tool_mcp_resources=0`，`tool_skill_resources=0`，`~/.tinadec/skills` 空，工作区无 `.tinadec/skills` |

## 断点 A：MCP 工具没有授予对话身份（主因）

`GraphSeedPack` 3.2.0 的 `meeting` 工具面是 37 个（`apps/desktop/src/agentPacks/GraphSeedPack/manifest.json:41` 起），
不含 `mcp_*`；`search` 的工具面明确包含三个 MCP 工具（同文件 `221-223`）。
这不是安装漂移：当前安装库里的 `meeting` 是 `source_key = tinadec.graph.seed-pack:meeting`，
37 个工具、`mcp_* = 0`；历史 3.0.1 包同样如此（`git show 441d8fa5:...manifest.json`）。

运行时是严格按 agent 自己的授权过滤的：

- 每个运行实例的 `AllowedTools = template.ToolCeiling`（`FullDuplexRunEngine.cs:2770`）；
- 模型可见工具 = 该实例的 `AllowedTools` ∩ 冻结 manifest（`FrozenToolManifestCatalog.cs:49-55`）；
- run 级 manifest 是**所有参与 agent + spawnable 模板的并集**（`FullDuplexRunCoordinator.cs:341-349`），
  所以 Solo 里 manifest 会包含 `mcp_*`（因为 `search` 是 spawnable），但 `meeting` 自己仍然看不到。

Solo 的实际执行路径是“对话身份自己干”（`FullDuplexRunEngine.cs:1318-1362`，
`ResolveSoloMaster` `3301-3315`），worker 就是 `meeting`，工具面就是那 37 个。
`meeting` 的 `relationship.agent_types` 含 `search/global_engineering`（安装库模式快照），
所以理论上它可以 `task_dispatch` 给 `search`——这是 MCP 目前**唯一**可能的到达方式，
而且要求协调者自己判断“该派给 search”。`search` 的职责描述是检索取证，没有任何 MCP 提示，
用户在对话里说“用我配置的 MCP 服务器做 X”时，没有任何机制保证会走到这条路。

在 `free_director`（Team）/ `review` / `spec` 里，`meeting` 节点的 `effective_tools` 是
**空数组**（安装库），连 `task_dispatch` 之外的工具都没有；MCP 只能靠派发 `search`。
`vibe_graph` 的 `search` 是节点，才有 `mcp_*`（安装库）。

这解释了一个很具体的现象：在设置 → 工具 → MCP 里加服务器、绑定给 `meeting`，
`/tools/settings/effective` 会如实返回 `mcp_servers`，但下一次 run 的模型工具面
依然没有 `mcp_*`；设置页的“工具能力”卡还会给这三个工具打上 **“未授予此智能体”**
（`ToolCenterSection.vue:229`，文案见 `locales/zh-CN.ts:44`）。
前端把话说清楚了，但 MCP 标签页本身没有任何提示，用户看到的仍是“绑定成功”。

## 断点 B：内置智能体无法在 UI 补授权（使 A 不能自助修复）

工具面由 agent 版本的 `tool_scope` 决定；`meeting` 是 pack 管理的内置智能体：

- `SettingsPage.vue:1252` 把 `managed`/非 custom 的定义都算作 `is_built_in`；
- 工具勾选与“全选/允许全部”按钮对 `is_built_in` 全部禁用（`SettingsPage.vue:3494-3512`），
  只提供克隆（`cloneAgent`，`1415`）；
- 克隆出来的是自定义 agent，不会被现有模式的节点自动引用，仍需改模式才能用。

代码里其实存在一个可用的覆盖通道：`PUT /api/v1/agent-definitions/{id}/model-binding`
接受 `tool_scope`（`AgentConfigurationEndpoints.cs:351-356,401`），
`FormalModeResolver.cs:256-259` 会用它替换节点的 `effectiveTools`。
但这条路径对内置智能体在 UI 上不可达，只有直接调 API 才能用。
因此“配置 MCP → 让主助手用”在产品内没有闭环。

## 断点 C：Skill 的发现面与当前资产不匹配

Skill 链路本身是通的，但入口很窄：

- 项目技能只从 `<workspace>/.tinadec/skills` 发现，最多两层（`WorkspaceSkillPolicy.cs:47,62-67`）；
- 共享技能从 Core 存储根 `skills/` 发现（`ToolSkillResourceService.cs:38`），市场安装走这里；
- `.claude/skills`、`.agents/skills`、仓库根的 `skills/` 都不在产品发现范围内。

当前机器：`tool_skill_resources` 为 0，`~/.tinadec/skills` 为空，
`C:\git\agent\TinadecOffice\.tinadec\skills` 不存在；
而仓库里真实存在的 4 个技能在 `.claude/skills`（开发侧链接到 `.tinadec_dev/skills`）。
所以即使对话身份有 `read_file`、上下文链路完全正常，索引也是空的。
这不是“代码没实现”，而是“用户资产与产品约定不是同一个目录”，且界面没有诊断。

另外两个会影响观感的设计点（不是缺陷，但需要知道）：

1. MCP 不是“每个 server 的工具直接出现在工具列表”，而是三个通用工具
   `mcp_list` → `mcp_search` → `mcp_invoke`（`McpListTool.cs:10`、`McpSearchTool.cs:11`、
   `McpInvokeTool.cs:14`，invoke 需审批）。习惯了 Claude/Codex 那种“MCP 工具即模型工具”的用户，
   会认为“没接上”。
2. 托管 run 下 `mcp_servers.json` 文件被有意忽略（`McpServerRepository.cs:21`；
   `ToolSettingsApiTests.cs:163` 的 `LegacyMcpFileIsIgnoredWhenTheNewScopeConfigurationIsAuthoritative`）。
   手工改文件的配置不会生效，只有 Core 资源库生效。

## 本轮验证到什么程度

已跑：

- Core API 定向 **36/36 通过**（`McpInventoryApiTests` 10 + `WorkspaceSkillApiTests` 26，
  含 MCP 清单出处、provider 不可用仍返回 200+source、共享技能冻结与索引）；
- Tools **8/8 通过**（真实 `node` stdio MCP 夹具，覆盖 list/search/invoke）；
- Gateway **8/8 通过**（MCP 读代理、工具设置/Skill 代理、错误码不被压成 conflict）。

未跑（不要当成已验收）：

- 真实 Electron 设置页点击与真实模型 run；
- 真实第三方 MCP server（本轮只有本地 Node 夹具）；
- PostgreSQL 与 Linux/macOS。

## 建议的修法（按成本从低到高）

**A. 最小可见修复（pack 层）**
在 `GraphSeedPack` 的 `meeting` 工具面加 `mcp_list/mcp_search/mcp_invoke`，
`metadata.version` 升到 3.2.1 并重算 `GRAPH_SEED_PACK_DIGEST`
（`apps/desktop/src/agentPacks/GraphSeedPack/index.ts:157,170`），
同步 `GraphSeedPack.test.ts` 与 Core 的假 manifest（`ToolChainEndpointTests.CreateManifest`）。
代价是 Solo 的对话身份直接持有 MCP 工具；Team 的纯协调者（0 工具）不受影响。
需要决定：MCP 是否属于“对话身份可自用”的能力，还是只属于执行体。

**B. 策略层（如果希望 MCP 自动生效）**
在 `ToolConfigurationResolver` 里，当 `settings.mcp.enabled=true` 且确有 server 时，
把 `mcp_*` 并入该 agent 的 `AllowedTools`（仍然只能收窄、不能超过冻结 manifest）。
这会改变授权语义：设置从“资源选择”变成“能力授予”，必须显式设计并补安全测试，
不能让一个可写的 settings 文档变成提权入口。

**C. UI 层（无论 A/B 都要做）**
在 MCP/Skill 标签页选中某个 agent 时，如果该 agent 的 `effectiveToolIds` 不含
`mcp_*`（或没有 `read_file` 因而技能正文读不了），直接在绑定栏给出阻断提示，
并提供“打开智能体中心/克隆后授权”的入口；不要只把 `notGranted` 藏在“工具能力”卡里。
如果要支持内置 agent 的工具覆盖，应走受治理的授权动作，而不是开放整份 `tool_scope`。

**D. Skill 发现面**
至少给出诊断：当 `.tinadec/skills` 不存在、但 `.claude/skills`/`agents/skills`/`skills/`
存在时，在设置页说明“产品不扫描该目录”，并提供导入按钮；
若产品定位要兼容 Agent Skills 生态，则把发现根扩到 `skills/` 与 `.claude/skills`
（需要决定优先级、同名冲突与只读边界）。

**E. 回归**
补一条真正覆盖“配置 MCP → 主对话 agent 的模型工具面包含 mcp_*”的 contract test。
现在的 MCP 测试全部使用 `worker.*`/`search` 这类执行体
（`ToolChainEndpointTests.cs:1516,2751-2757`、`FrozenWorkerSelectionTests.cs:151`），
没有任何一例断言对话身份能拿到 MCP——这正是这个断点能长期存在的原因。
