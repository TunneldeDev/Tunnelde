# 共享挂载规则与专用连接

主机挂载是宿主持久功能。SSHFS 和 SSHFS Lite 等插件读取同一套规则、组和运行状态；
切换 `mountHostDetailsSelection` 只更换主机详情组件。通过 `extensions.describe().mounts`
发现能力，通过 `api.describe` 读取各方法实际参数与权限。前端类型由
`uiSdkContract` 的 `MountGroup`、`MountRule`、`MountSnapshot`、`MountOperation` 导出。

`mounts.read` 允许读取共享数据、检查依赖和路径；`mounts.write` 允许修改配置、连接、挂载、
卸载及取消操作。交互主机详情贡献另外需要 `mounts.hostDetails`，见 [主机详情扩展](host-details.md)。
这些接口既可用于详情卡片，也可用于跨主机总览或后台插件。

## 从一次性挂载迁移

用运行中的宿主做能力检查，而不是根据旧版 SDK 的方法列表判断。前端使用
`context.api.call(method, params)`，Node 插件使用 `host.call(method, params)`：

```js
const capabilities = await api.call("extensions.describe", {});
const { methods } = await api.call("api.describe", {});
const supported = new Set(methods.map(({ name }) => name));
const sharedMounts =
  capabilities.mounts?.configuration === "persistent-shared" &&
  [
    "mounts.rules.snapshot",
    "mounts.groups.save",
    "mounts.groups.connect",
    "mounts.groups.observe",
    "mounts.runtime.connectAndStartAuto",
  ].every((method) => supported.has(method));
```

已保存的组和规则直接读 `mounts.rules.snapshot({hostId})`，不要在插件私有存储中另建副本。
保存组时设 `autoReconnect: true`，然后由用户显式调用 `mounts.groups.connect({id})`，
或调用 `mounts.runtime.connectAndStartAuto({groupId})` 同时启动标记了 `autoMount` 的规则。
连接和恢复由宿主运行，插件不用提供 `sessionId`、自己重连或把规则广播给另一款插件。
更新已有组时须先断开，并传当前 `expectedRevision`。已存在的一次性挂载只在用户确认后迁移。

旧声明式视图块 `{ "type": "mounts" }` 仍显示一次性面板，不会自动升级成共享规则管理器。
它不执行任意 RPC；目前要使用共享规则界面，需要可信组件视图。旧 SDK 未声明的方法应以
实时 `api.describe` 为准，不应回退到旧 `mounts.mount` 后仍标记为「共享」或「自动恢复」。

## 配置

组为 `{id, hostId, name, autoReconnect}`；规则为
`{id, hostId, groupId, name, remotePath, mountPoint, readOnly, autoMount}`。
ID 由调用方分配，允许字母、数字、`-_.`，最长 128 字节。远端路径为绝对 SFTP 路径，
包括 Windows 服务器的 `/C:/...`。本地路径为绝对路径；Windows 只接受未占用盘符根目录，
其他系统要求存在的空目录。规则默认只读，不会默认自动挂载或自动恢复。

`rules.get`、`groups.get` 返回 `{revision, value}` 或 `null`。
`rules.save({rule, expectedRevision?})`、`groups.save({group, expectedRevision?})`
省略版本只允许创建新 ID；修改必须提供精确版本。运行规则需要先停止，组配置需要先断开。
主机删除会级联删除配置并清理运行资源。规则不能引用其他主机的组。

| 操作                       | 方法                                                                              |
| -------------------------- | --------------------------------------------------------------------------------- |
| 主机完整快照               | `mounts.rules.snapshot({hostId})`                                                 |
| 分页列表                   | `mounts.rules.list`、`mounts.groups.list`                                         |
| 单条读取、校验、保存、删除 | `mounts.rules.get/validate/save/remove`、`mounts.groups.get/validate/save/remove` |
| 移动规则                   | `mounts.rules.move({id, expectedRevision, groupId})`                              |
| 复制主机规则               | `mounts.rules.copyHost({sourceHostId, targetHostId, expectedRevision})`           |
| 分页导出                   | `mounts.rules.export({hostId, cursor?, revision?, limit?})`                       |
| 导入预览与应用             | `mounts.rules.importPreview`、`mounts.rules.importApply`                          |

每主机最多 32 组、128 规则，全局最多 512 组、2048 规则。列表每页 1–32 条，
返回 `{revision, items, nextCursor}`；继续翻页必须携带原集合版本，发生变化后从第一页重读。
快照返回配置版本 `revision` 和运行版本 `runtimeRevision`，版本均为不透明字符串。

复制分配新 ID，并关闭副本的 `autoMount`，避免自动争用本地挂载点。
导出返回 `{revision, nextCursor, document}`，文档为
`{version:1, hostId, groups, rules}`。每次导入最多 32 组和 32 规则，模式为
`reject`（默认）、`replace` 或 `skip`。预览返回 `{revision, digest, conflicts, groups, rules}`；
应用必须提交相同文档、`expectedRevision` 和 `digest`。应用重新校验，任何一项失败整批回滚。
不能替换正在运行的配置。较大的导出可分批导入，每批重新预览；重复组可用 `skip`。

## 连接、运行与进度

每组建立一个宿主持有的后台 SSH 连接。组内规则共享该连接，终端和普通 SFTP 会话保持
各自的生命周期。连接使用已保存凭据和现有主机密钥校验，不自动信任新密钥。
保存、导入规则和切换界面不会建立连接；显式调用 `connectAndStartAuto` 才连接并启动自动规则。
`autoMount` 用于该操作的规则筛选，应用启动时不会自行连接所有主机。

```ts
const api = context.api;
const snapshot = await api.call("mounts.rules.snapshot", { hostId });
const operation = await api.call("mounts.runtime.connectAndStartAuto", { groupId });
let progress = operation;
while (["pending", "running"].includes(progress.phase)) {
  progress = await api.call("mounts.operations.observe", {
    id: progress.id,
    revision: progress.revision,
  });
}
```

| 操作                         | 方法                                                       |
| ---------------------------- | ---------------------------------------------------------- |
| 组连接、断开、重连           | `mounts.groups.connect/disconnect/reconnect`               |
| 单规则启动、停止、重启、重试 | `mounts.runtime.start/stop/restart/retry`                  |
| 顺序批量启停                 | `mounts.runtime.startMany/stopMany`                        |
| 自动规则启动                 | `mounts.runtime.startAuto/connectAndStartAuto`             |
| 主机全部或手动规则启动       | `mounts.runtime.startAll({hostId, mode?:"all"\|"manual"})` |
| 主机全部规则停止             | `mounts.runtime.stopAll({hostId})`                         |
| 强制卸载确认                 | `mounts.runtime.requestForceUnmount({id, runtimeId})`      |
| 打开、定位挂载文件           | `mounts.runtime.open/reveal`                               |
| 连接状态                     | `mounts.connections.list/get/observe`                      |
| 操作摘要、详情、观察、取消   | `mounts.operations.list/get/observe/cancel`                |

启停、组删除和规则删除返回操作回执，逐项状态为 `pending/running/succeeded/failed/blocked/cancelled`。
组连接失败会阻止该组依赖步骤，其他组继续；单规则挂载失败不会阻止其他规则。
取消阻止尚未执行的后续步骤，正在执行的步骤可能已经提交，不承诺回滚已完成的挂载。
全局最多 8 个活动操作，每插件最多 4 个；保留最近 128 个回执，单批最多 256 步。
`operations.list` 每页 16 个摘要，`get` 返回单个完整回执；`observe` 最多等待 5 秒。

运行状态包含规则版本、运行实例 `runtimeId`、`desired` 和错误。
停止可提供 `runtimeId`，避免误停替代实例。错误包含 `code/message/category/retryable`；
分类包括认证、信任、路由、依赖、冲突、传输、清理、校验和内部错误。
卸载失败会保留挂载点预留与运行实例，清理前不会删除对应配置。
强制卸载必须经过宿主确认，取消确认不会改变运行状态。

`autoReconnect` 仅恢复已请求的连接及之前需要运行的规则。重试按 2、4、8、16、32、60 秒退避，
最多并行恢复 4 组，连接超时 90 秒。手动停止规则或断开组会暂停对应恢复。
认证、主机密钥或原路由变化进入 `needsAttention`，不会自动接受新路由或信任。
排除问题后可显式重连；重连恢复提交时仍为 desired/running 的规则。

`groups.observe({hostId, revision?, runtimeRevision?})` 返回新快照；只有两个版本都未变才等待。
`connections.observe({revision?})` 返回 `{revision, items}`，使用其返回的运行版本继续观察。
原生会发送 `mounts://changed`、`mounts://operation-changed` 作为失效通知，事件不携带凭据。
前端插件可以通过上述观察方法持续更新，不需要绕过 RPC 导入原生接口。

## 路径、依赖与迁移

- `mounts.paths.remote.browse({groupId, path?, offset?})` 使用已连接组的 SFTP 列目录，
  每页最多 128 个目录，返回 `nextOffset`；远端列表可能变化，偏移不保证目录快照。
- `mounts.paths.remote.resolve` 规范化远端目录；`mounts.paths.local.pick` 选择目录或确认盘符；
  `mounts.paths.local.validate` 检查本地挂载点。
- `mounts.paths.conflicts({path, excludeRuleId?})` 检查已配置和活动挂载点，最多返回 128 项，
  另含 `total/truncated`。路径查询使用有界工作线程和五秒期限。
- `mounts.dependencies.get/refresh/documentation` 检查 SSHFS/FUSE 并打开安装说明，不安装系统依赖。
- `mounts.legacy.list({hostId?, offset?})` 返回最多 32 个未忽略的一次性挂载。
  `legacy.convert({id, ruleId, groupId, expectedGroupRevision, name})` 把活动挂载转为新规则，
  原子转移挂载资源归属，保持文件访问，不接管或断开原终端 SSH 连接。
  转换后默认关闭 `autoMount`；下次重启规则改用组专用连接。
  `legacy.dismiss({id})` 只隐藏迁移提示。

旧 `mounts.list/mount/unmount/open` 仍按原插件隔离，不改变既有契约。
新共享接口可管理所有宿主规则；插件停止或切换贡献者不会删除配置或终止宿主持有的挂载。
