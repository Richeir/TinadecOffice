# Core 启动/挂载性能修复证据

**日期：** 2026-10-18
**负责人：** lead
**范围：** TinadecCore 启动与项目 scope 挂载（用户报告"应用界面加载慢"的后端主因）

## 结论（一句话）

真实项目 scope 挂载 **67.7s → 2.37s（28×）**，事件索引 3,247 行完整无缺失。
两处 N+1 查询是唯一根因，均与业务数据量线性相关，因此用户数据越多越慢——这解释了"整个应用都很慢"的主观体感。

## 修复 1：事件索引重扫的逐条存在性查询（TinadecCore/Lifecycle/StorageLifecycleService.cs）

**修改前**（ReconcileAsync，位于 StorageScopeRegistry.MountAsync 的挂载路径上）：

```csharp
while (offset < bytes.Length) {           // 每条事件记录一次往返
    var record = JsonSerializer.Deserialize<EventFileRecord>(...);
    if (!await db.EventIndex.AnyAsync(x => x.EventId == record.EventId, ct))
        db.EventIndex.Add(new EventIndexRecord { ... });
}
```

**修改后**：整趟重扫只读一次 event_index 的 event_id 集合，循环内用 `known.Add(id)` 判定。

- 语义保持完全一致：原判定是**全局** event_id（event_index 主键），因此集合也是全局的；跨 run 重复事件仍然是"跳过"而不是重复插入。
- 幂等性不变：新插入的 id 立刻进入集合，同一趟内重复行也不会插入两次。

**实测**（真实项目 C:\git\agent\RouterAPI，19 个 run / 3,247 条事件 / 4.0MB JSONL）：

| 指标 | 修复前 | 修复后 |
|---|---|---|
| 首个 GET /api/v1/projects | 67.7s（另两次独立复现 79.2s、66.6s） | **2.37s** |
| 该窗口内 SELECT 次数 | 3,288 | 929 |
| 其中 SELECT EXISTS(event_index) | **3,247 次 / 21.7s 纯执行** | 0 |
| event_index 行数 | 3,247 | **3,247（不变）** |

## 修复 2：表结构对齐的逐表/逐列 pragma 探测（TinadecCore/Persistence/DbContextMigrationParticipant.cs）

12 个 DbContext 各自在挂载时做列对齐，每个表一次 `pragma_table_info`、每个可空列再一次 `pragma_table_info ... WHERE name=`。

**修改后**：新增 `SqliteColumnCatalog`，每个 context 用**一次** `sqlite_master JOIN pragma_table_info` 读回全部表/列/notnull，之后内存查询；契约不变（表不存在→null，列不存在→null）。

**实测**（同一挂载窗口内）：

| 指标 | 修复前 | 修复后 |
|---|---|---|
| pragma_table_info 调用 | **698 次 / 5.8s** | 12 次（每 context 一次） |
| 挂载总耗时 | 16.4s（仅修 #1 后） | 2.37s（两者都修后） |

## Core 进程启动基线（Release，本机 8 核）

| 配置 | 到 /health 200 |
|---|---|
| Release 自包含（apps/desktop/runtime 暂存产物） | 11.1s |
| Release 构建 + storage scopes 关闭 | 6.8-7.3s |
| Release 构建 + storage scopes 开启 | 11.7-13.0s |
| Debug 构建（开发态） | 12.2-14.9s |

**结论**：.NET 框架 + DI 容器启动本身就是 6.8s 地板，storage scope 初始化额外 ~5s。
Debug 比 Release 慢 ~2s。**这部分不在本仓库能显著优化的范围**（不是我们代码的问题，是 .NET 宿主 + 12 个模块的 DI 图构建成本），不要承诺压到 1-2s。

## 验证

- `TinadecCore.Api.Tests` 定向 40/40 通过（SchemaReconciliation / DmaeaGraphSchema / TinaChatWakeSchema / LegacyRouteSchema / AttachmentApi），耗时 2m13s。
  `pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/setup-dotnet-env.ps1 test TinadecCore/tests/TinadecCore.Api.Tests/TinadecCore.Api.Tests.csproj --filter "FullyQualifiedName~SchemaReconciliation|FullyQualifiedName~DmaeaGraphSchema|FullyQualifiedName~TinaChatWakeSchema|FullyQualifiedName~LegacyRouteSchema|FullyQualifiedName~AttachmentApi" /m:1 --artifacts-path .tinadec_dev/tmp/perf-reconcile`
- 真实数据库行数核对：修复后 event_index 仍是 3,247 行（无重复、无缺失）。
- 未跑：Core 全量测试套件、PostgreSQL 路径、其他平台。

## 未做/边界

- Core 全量测试套件未跑（本轮只跑了列对齐与事件索引相关）。
- PostgreSQL：两处修复都只在 SQLite 分支生效；PostgreSQL 的 `information_schema` 查询路径原本就是按表一次（未做逐列 N+1），但仍可按同样方式收成一次调用。
- 事件重扫仍是全量：每次挂载都会重读所有 JSONL。改增量（记 last offset）会动到恢复语义，本轮按"最小改动"未做；数据量继续增长时这是下一个优化点。
