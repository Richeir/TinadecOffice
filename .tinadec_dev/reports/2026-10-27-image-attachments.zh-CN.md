# 图片附件多模态链 + 工作空间一等资源（2026-10-27）

## 结论

本轮把原计划中“附件记录”和“工作空间文件授权”拆开实现，并补齐了原方案最大的产品缺口：

- 文件夹是递归资源授权；
- 单个文件是精确原路径授权，拖入默认绑定原文件，不再默认复制；
- 会话附件是“Agent 实际看过什么”的事实，不会被伪装成文件权限；
- 普通 composer 附件与 workspace 来源附件都能按项目统一曝光；
- 图片能力必须由 provider/model 显式声明，能力或预算不足时给出可见的未送达原因。

## 实现

### 工作空间精确文件

- `WorkspaceDefinition.Files` / `WorkspaceFileGrant`；`project.toml` 使用 `[[workspace.files]]`。
- 宿主登记保存 `authorized_files` / `historical_files`；篡改项目文件不能自我授权。
- `ToolExecutionContext.workspace_files`、资源 claim、TinadecTools 精确路径判断、沙箱读/写授权、Windows runner `--workspace-file` 与进程 key 都包含文件资源。
- 单文件快照由 `FileWorkspaceSnapshotProvider` 捕获/恢复，只包含该文件，不扩展到父目录。
- 工作空间卡新增精确文件列表；拖文件绑定原路径，“复制进工作空间”和“附到当前对话”是另外两个显式动作。

### 附件一等事实

- `message_attachments` 新增 `origin`、`project_id`、`source_path`、`delivered_to_model`、`delivered_run_id`、`delivered_at`。
- SQLite migration 先以 `CREATE TABLE IF NOT EXISTS` 建立完整新表，再由既有模型列对账兼容旧表；避免在 fresh DB 上 alter 尚不存在的表。
- 会话附件 DTO 与消息内嵌 summary 同步新字段。
- `GET /api/v1/projects/{id}/exposures` 返回项目全部来源的附件曝光；Gateway 为薄代理，Desktop 工作空间卡展示缩略图、来源、会话与送达状态。
- composer 附件自动关联 session 的 project；workspace 来源必须声明项目并给出当前授权路径。

### 图片多模态

- HTTP provider 通过 `image_input` opt-in，支持 `enabled`、单图字节、每轮张数与 `model_overrides`。
- ACP 从最近一次 initialize 的 `_capabilities.image_input` 读取能力快照；OpenCode/TUI/Headless 恒 false。
- `AttachmentImageParts` 只读取触发消息绑定的图片：
  - 单图上限来自能力配置，最高 32 MiB；
  - 每轮默认最多 8 张；
  - 每轮图片总量 32 MiB；
  - 超能力、超张数、超单图或总量都写“哪张图未送达、为什么”。
- MAF governance turn 与 worker goal 都接收 `DataContent`；ACP client 将它映射为 image content block；OpenAI/Anthropic 由 SDK 原生序列化。
- 只有模型调用成功返回后才写 attachment delivery receipt；同一附件重复标记保持首次 run 事实。

### Desktop 行为

- 附件 `staged` 状态保存本地文件引用；没有 session 时不上传、不创建会话。
- 发送时先创建 session，再 `flushStagedAttachments`，最后提交 interaction；附件-only 发送由 `pendingAttachmentCount` 正确解锁。
- workspace “附到当前对话”携带 `origin=workspace` 与真实 `source_path`，但仍是普通待发附件状态。
- 模型参数编辑器新增图片轴；ACP/unsupported 通道只读。

## 验证

- Core build：0 errors。
- AgentFramework 定向：40/40（图片能力映射、预算/Datacontent、精确 file claim、ACP image block）。
- Api 定向：附件曝光/送达/非法 workspace 来源与精确文件授权/快照组 4/4；单文件快照最终复跑 1/1。
- Gateway：109/109，外部 OpenAPI 快照与声明 schema 已再生。
- Desktop：目标 7 套件累计 237/237（含新增图片参数与 workspace 暂存上传用例），关键 3 套件复跑 71/71；`vue-tsc --noEmit` 0。
- Desktop production `vite build`：exit 0，6m46s；仍报告既有的大 chunk/循环 chunk 警告。
- `schema.d.ts` 再生成幂等：SHA-256 `19F960DF2AD1A00C5030102B84C57BA29060FD20BE3248600B18BA81ED7E98CE`。
- `git diff --check`：无 whitespace error。

## 未验证

- 真实视觉模型对图片内容的识别；本机没有使用真实 provider/key 做多模态回合。
- 真实 Electron 中拖入文件、绑定原路径、附到当前对话、发送后曝光列表刷新与模型输入。
- PostgreSQL 实库上的新列行为；SQLite 迁移与测试宿主已覆盖。
- ACP 真实 harness 的图片上传；当前只验证 wire 映射与能力快照逻辑。

## 诚实边界

- Core 能验证 `source_path` 是当前项目授权路径、存在且不是链接，但不能证明客户端上传的字节与磁盘原文件完全相同。附件字节是上传时不可变副本，文件授权仍指向原路径。
- meeting/interaction 回合不重放历史图片；后续 run 依赖 ContextPack 的文本引用。
- steering 仍然拒绝附件。
