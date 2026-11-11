# 宿主存储恢复

`storage.recovery.observe` 和 `storage.recovery.request` 是实验性 API v1 方法。
调用前通过 `api.describe` 检查支持情况。它们与插件键值存储、未开始的位置计划分开。

观察需要 `storage.recovery.read`，请求恢复还需要 `storage.recovery.write`。
即使插件已经批准，宿主仍会在恢复操作前标明插件身份并要求用户确认。

```js
import { createHostStorageRecoveryClient } from "./sdk/storage/recovery/client.mjs";
const recovery = createHostStorageRecoveryClient(host);
const observation = await recovery.observe();
if (observation.changed && observation.snapshot.pending) {
  const result = await recovery.request(
    { revision: observation.revision, action: "retry" },
    { signal: owner.signal },
  );
  // restartScheduled 只表示意图已记录，由用户选择重启时间。
}
```

独立快照包含 `version: 1`、不透明 `revision`、按顺序排列的八项当前/默认
`locations`、`pending` 或 null、`recordedCopies` 与 `hasError`。待执行元数据包含
`action: apply | cancel`、`restartRequested` 和精确规范化的 `changes`。
副本按类别及 `previous`/`archive` 排列，每种类别/类型最多记录一个路径。
不会返回原始错误、私有计划标识、秘密或文件内容。记录路径不能证明文件存在、
完整性、排他归属、历史清单完整性，也不授权删除。读取不扫描或探测这些副本。

`request({revision, action: "retry" | "cancel"})` 必须匹配精确待执行计划。
retry 保持已持久化方向，包括取消；cancel 不可逆地改为取消方向。
确认窗口 55 秒后失效，SDK 默认传输超时为 70 秒。确认后原生服务在替换有界、
已同步的配置元数据前，重新检查版本、运行代次/权限及取消围栏。
插件权限围栏内不会执行迁移文件操作。成功返回
`{version:1, outcome:"restartScheduled", snapshot}`，拒绝返回包含最新快照的
`dismissed`。不会自动重启或删除恢复副本。

下次启动在数据库、插件及其他写入者打开前，先消费 `restartRequested` 再执行恢复。
设置会区分已安排恢复与执行失败，并保留上次错误直到恢复成功。
执行中断后保留计划及方向。重复相同精确请求仅重新保存元数据。
超时或回复丢失后应重新观察真实状态，不能自动重试可能已经提交的写入。

`observe({revision?})` 在状态未变化时省略快照。版本包含私有配置身份及公共投影，
但不赋予文件系统权限。SDK 的 `subscribe(callback,{signal,intervalMs?})` 串行轮询
最新状态、合并相同版本，并随所属方退出。它不是逐次写入事件日志。

严格请求拒绝额外字段、null 版本。版本为 1–128 UTF-8 字节；绝对 UTF-8 路径最多
4096 字节且不含控制字符。快照最多 127 KiB，响应最多 128 KiB。
机器结构见 `src-tauri/src/plugins/api/domains/storage/recovery/schema.json` 及镜像 SDK
类型。`storage.recovery.conflict` 要求刷新并重新确认；`noPendingPlan`、`busy`、
`invalidState`、`unavailable` 均为明确失败。

本接口不提供跨进程父目录排他权威、物理断电/介质故障保证、降级恢复、自动孤儿清理或
完整归档历史。请保留外部备份。原有位置 API 及快照不变；
`storage.locations.cancel` 仍拒绝存在恢复副本的计划，不会删除这些副本。
