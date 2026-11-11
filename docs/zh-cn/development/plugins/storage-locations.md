# 宿主存储位置

这些实验接口管理软件全局的存储位置元数据，与[插件自有 JSON 存储](storage-observation.md)、设置和密钥链分开。调用前通过 `api.describe` 检查支持情况；位置权限不授予文件内容访问权。

| 方法                         | 所需权限                             | 行为                                     |
| ---------------------------- | ------------------------------------ | ---------------------------------------- |
| `storage.locations.observe`  | `storage.locations.read`             | 条件读取元数据，不递归扫描目录           |
| `storage.locations.schedule` | 读取权限和 `storage.locations.write` | 审查规范化目标，计划下次重启时迁移       |
| `storage.locations.cancel`   | 读写权限                             | 审查并取消尚未开始的计划，不删除恢复文件 |

`observe({})` 返回 `{version:1, revision, changed:true, snapshot}`。修订号匹配时返回 `changed:false`，不附带快照。快照包含按顺序排列的八类位置：`database`、`plugins`、`pluginData`、`keys`、`runtimes`、`cache`、`logs`、`runners`。每项含 `path`、`defaultPath` 和 `overridden`（插件目录被环境强制指定）。`pending` 为 null 或 `{changes:[{category,target,migrate}]}`；`recoveryRequired` 表示此前错误、暂存文件、发布标记或恢复日志需要处理。不暴露原始错误、恢复 ID、文件清单及内容。只检查少量标记的元数据，订阅不会扫描目录内容。

通过 `sdk/storage/locations/client.mjs` 的 `createHostStorageClient(host)` 使用接口。`subscribe` 必须绑定所有者的 `AbortSignal`；每个客户端最多八个订阅，串行读取和回调，间隔 1–60 秒，读取截止时间十秒。状态变化可以合并，不是逐次写入的审计日志，也不使用插件 KV 客户端的权限和数据。

```js
const current = await client.observe();
const result = await client.schedule(
  {
    revision: current.revision,
    changes: [{ category: "cache", target: "/absolute/new-cache", migrate: true }],
  },
  { signal: owner.signal },
);
// result.outcome 为 scheduled 或 dismissed；查看 result.snapshot。
```

计划接受一至八个不重复的类别。路径须为绝对路径、有效 UTF-8、最多 4096 字节且无控制字符；修订号为 1–128 个 UTF-8 字节且无控制字符。拒绝 null 和未知请求字段，沿用宿主的路径、重叠、目标和容量验证。原生确认框标明插件、类别、原位置、规范化目标、是否复制数据及重启时机，55 秒超时，不替换其他弹窗。SDK 修改调用默认等待 70 秒。最终写入前再次验证目标及修订号；与原生设置并发修改时返回 `storage.locations.conflict`。

取消尚未开始的计划需要其准确修订号。需要恢复的计划返回 `storage.locations.recoveryRequired` 并保留，交由原生恢复处理。成功修改返回 `{version:1,outcome:"scheduled"|"cancelled",snapshot}`；用户拒绝时返回 `dismissed` 和重新读取的快照。计划成功后显示常规重启提示，不会自动重启或立即迁移。在发布围栏前取消请求可以阻止配置提交；提交后的取消不回滚，丢失回复时应重新读取状态。临时元数据在策略围栏外完成同步，拒绝时清理。原生最多四项未结束操作，包含尚未退出的阻塞线程及待确认操作；超额返回 `plugin.api.busy`。

机器 Schema 位于 `src-tauri/src/plugins/api/domains/storage/locations/schema.json`，独立 DTO 位于 `contracts/storage/locations/`，自动镜像到 SDK 并检查偏差。快照最多 127 KiB，回复及持久化配置最多 128 KiB。测试将真实原生输出、Schema 与实际 SDK 消费者联检。这些保证针对计划元数据，不代表迁移恢复、文件修改及跨卷操作全部安全；接口仍为实验状态。

若原生存储操作占用写锁，提交围栏返回 `storage.locations.busy`，不持有插件策略锁等待目录扫描；请重新读取状态后重试。
