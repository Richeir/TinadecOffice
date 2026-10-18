# 会话列表的逐条 workspace-defaults 读取（N+1）

**日期：** 2026-10-18（第二轮）
**负责人：** lead
**范围：** `GET /api/v1/sessions` 的响应组装（TinadecCore）

## 结论

`/api/v1/sessions` 组装每个会话时都新建一个 `AgentConfigurationDbContext` 并查一次 `workspace_defaults`，
而 `workspace_defaults` 是**每个 workspace 一行**。真实项目 9 个会话、1 行默认值 ⇒ **9 次 DbContext + 9 次查询**。

改成批量读一次 → **p50 270 ms → 54 ms（约 5 倍）**。这是首屏路径（会话列表是主界面第一批数据），
与用户报告的"界面加载慢"直接相关。

## 现场数字（真实项目 C:\git\agent\RouterAPI，19 run / 3,247 事件 / 9 会话 / 1 行 defaults）

| 指标 | 改前 | 改后 |
|---|---|---|
| `GET /api/v1/sessions` p50 | **270 ms**（241/293/268/263/270） | **54 ms**（min 47 / p50 54 / p90 67 / max 72，n=12） |
| 每次请求 `workspace_defaults` 查询数 | **9**（每个会话一次） | **1** |
| 每次请求 `AgentConfigurationDbContext` 新建数 | **9** | **1** |

同机同轮对照（未改动的接口作为参照，排除机器噪声）：`/api/v1/agents` p50 **314 ms** 两轮不变，
说明 270→54 不是环境波动。

## 为什么这是 N+1 而不是大查询

`ToSessionEnrichedAsync` 在 `foreach (var s in sessions)` 里被逐条调用，函数内部：

```csharp
await using var cfg = await cfgFactory.CreateDbContextAsync(ct);          // 每会话一个新 context
var wsDefault = await cfg.WorkspaceDefaults.AsNoTracking()
    .FirstOrDefaultAsync(x => x.TenantId == session.TenantId
                           && x.WorkspaceId == session.WorkspaceId, ct);  // 每会话一次查询
```

而 `WorkspaceDefaultsRecord` 的主键就是 `(TenantId, WorkspaceId)` —— 同一 workspace 的每个会话
都读出**完全相同的同一行**。会话数随使用增长，这条路径随之线性变慢。

## 改法

把两件事拆开：

1. `LoadSessionModeDefaultsAsync(sessions, cfgFactory, ct)` —— 一次 `Where(tenant IN … && workspace IN …)`
   读回全部需要的行，建 `(TenantId, WorkspaceId) → DefaultModeVersionId` 字典。
2. `ToSessionEnriched(session, storageId, defaults)` —— 纯同步投影，从字典取这一行的 default。

两个批量调用点（多 scope 聚合分支、单 scope 分支）各读一次；单会话路径（创建后回包、单个 GET）
保留 `ToSessionEnrichedAsync` 惰性回退，所以单独读一个会话仍然正确。

`has_update` 的算术**逐字保持原样**：`latest=null` ⇒ 无更新；否则 `session.ModeVersionId != latest`。
（原实现分两个分支写，等价于同一个表达式，这里合并并保持语义。）

## 验证

- `SessionListModeDefaultsTests`（新增，端到端）：真实 HTTP 建 3 个会话 → 直接查库取期望值 →
  `GET /sessions` 逐条比对 `has_update` 与 `latest_mode_version_id`；并**额外插入一个外部 workspace
  的 defaults 行（不同 default）**，确认不会串到本 workspace 的会话上。
- 定向回归 **27/27**（SessionListModeDefaults + StorageScopeApi + StorageLifecycleGraph，5 m 28 s）。
- 语义抽查（真实项目）：9/9 会话拿到同一个 `latest_mode_version_id`，`has_update=true`，
  与该 workspace 的 mode 确实不同于 default 一致。

## 守卫的诚实边界

**这个测试守的是结果，不是查询次数。** 如果后人把实现改回"循环内逐条读"，测试仍然会绿——
那是性能回归，只能靠本文件里的数字和评审守住，功能测试抓不住。

实际做过变异验证：把查询的 `workspace` 谓词删掉 → 测试**仍然通过**（外 workspace 的行落在字典的
另一个 key 上，不会污染本 workspace 的结果；它只是多读一行）。所以那个变异本身不是有效回归，
这也写进了测试注释，避免后人误以为它有防护力。

## 未做/边界

- Core 全量套件未跑；PostgreSQL 路径未跑（本次改动是纯 EF LINQ，provider 中立，但未实测）。
- `/api/v1/agents` 仍是 p50 314 ms，**本轮未动**。它的形状是 67 个 preview 请求 + 20 个定义，
  `PreviewBatchAsync` 已有批内缓存；要再降需要 profile 服务端算子，未做。
  （原先怀疑的 `ListAgents` 载入全部 `model_invocations` 问题：真实项目库 173 行 succeeded / 6 个 agent，
  量级太小，**实测不构成瓶颈**，因此没有改——避免无收益改动。）
