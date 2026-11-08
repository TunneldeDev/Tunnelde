# 插件 API 兼容性与安全

[English](plugin-api.en-us.md) · [插件概览](plugins-overview.zh-cn.md) ·
[插件开发详细指南](plugins.zh-cn.md)

本文面向插件开发者，介绍当前的接口发现契约和安全边界。贡献格式、具体限制和各方法
的用法请参阅详细指南及独立市场仓库中的 SDK 目录。应用和 SDK 可以独立发布，因此应
检查目标宿主的能力，不要假定 SDK 中的每个方法在所有宿主版本中都存在。

## 发现可用能力

清单中的 `apiVersion: 1` 标识协议，并不表示所有方法或数据结构都已承诺稳定。宿主在
执行前会检查该版本和已声明的 `engines.tunnelde` 范围。已获批准且正在运行的可执行
插件可以用空对象调用 `api.describe`，获取协议版本 `1` 和当前宿主提供的方法。接口
发现本身不需要领域权限，但后续每次请求都要单独授权；方法出现在目录中不等于已获授权。

方法描述包含 `name`、`permissions`、`params`、`description`、`stability`、`since` 和
`deprecated`。稳定核心方法还提供可选的 `contract`，包含 `version: 1`、draft-07 JSON
结构 `inputSchema`、`resultSchema`、`errorSchema`，以及 `knownErrors` 和 `events`。
`params` 仍是说明文字。结构校验与授权、编码字节限制及运行状态检查分别进行。
旧宿主可能没有契约或稳定性元数据，应将缺失信息视为未知。客户端应忽略新增字段和不认识的稳定性值。

| 稳定性         | 含义                                                                                                         |
| -------------- | ------------------------------------------------------------------------------------------------------------ |
| `stable`       | 对文档中规定的请求、响应和授权行为作兼容性承诺；`since` 表示首次支持的宿主版本。兼容更新可以新增字段或方法。 |
| `experimental` | 行为和数据结构可能变化；应发现能力并处理失败。                                                               |
| `deprecated`   | 请查看 `deprecated` 字段中的迁移说明。                                                                       |

首批稳定核心为 `api.describe`、`sessions.list`、`storage.get`、`storage.set` 和
`storage.delete`。这些方法自 0.21.0 起提供；`since` 表示首次可用版本，不表示稳定承诺
建立的版本。稳定范围还包括 `statusBar.set`/`statusBar.remove` 和
`editor.active`/`editor.replace`。编辑器方法自 0.29.0-beta.2 起提供，本次明确冻结
其 v1 契约。`workspace.snapshot` 也具有冻结的只读 v1 契约；设置、工作区修改、
聊天、远端运行器及其余面板方法仍为实验接口。
稳定契约的不兼容变更需要明确的版本化迁移。

冻结的接口发现[请求结构](../tests/fixtures/plugin-compat/api-describe-v1-request.schema.json)
和[响应结构](../tests/fixtures/plugin-compat/api-describe-v1.schema.json)定义了其 v1
兼容性底线。发现接口不产生事件。CI 会校验宿主生成的响应，并检查该方法的元数据和
权限。独立冻结的[核心 v1 契约](../tests/fixtures/plugin-compat/core-v1.json)定义其他稳定
方法的输入、输出和错误。后续可以新增字段，调用方必须忽略不认识的字段。

## 稳定核心的行为

| 方法             | 权限            | 输入与返回值                                                                        |
| ---------------- | --------------- | ----------------------------------------------------------------------------------- |
| `api.describe`   | 无              | 对象参数；返回协议版本和方法说明。                                                  |
| `sessions.list`  | `sessions.read` | 对象参数；返回当前已认证的 SSH 会话，可能为空数组。已保存主机不等于会话。           |
| `storage.get`    | 无              | `{key}`；返回该插件的 JSON 值，不存在时返回 `null`。存入 JSON `null` 时返回值相同。 |
| `storage.set`    | 无              | `{key,value}`；接受包括 `null` 在内的任意 JSON 值，替换后返回 `null`。              |
| `storage.delete` | 无              | `{key}`；存在时移除该值，键不存在时也返回 `null`。                                  |

所有方法都要求插件已批准且正在运行；授权撤销或受限模式会拒绝访问。存储按插件身份
隔离，运行时重启后仍保留，不需要文件系统权限。键由 1–128 个 ASCII 字母、数字、点、
下划线或连字符组成；`__proto__`、`constructor`、`prototype` 为保留名称。
额外的对象字段会被忽略。请求按 UTF-8 编码后的 JSON 限制为 256 KiB；完整持久化存储
对象（包括所有键和 JSON 开销）也限制为 256 KiB。请求未超限，仍可能超过总存储配额。
字节限制独立于结构校验。写入采用替换 JSON 文件的方式，不承诺断电持久性。
这五个方法均不产生事件。

会话返回 `id`、`hostId`、`title`、`address`、`cols`、`rows`、`connectedAt`（Unix 时间戳，
毫秒）。不会暴露内部终端和连接用途字段。列出会话并不保留它，后续操作仍可能因断线
失败。`sessions.connect` 使用相同的返回结构，但该方法仍为实验接口。

宿主调用失败时返回 JSON-RPC `error`，包含整数 `code`、字符串 `message`，通常还包含
表示错误类别的 `data.code`。非法参数对象或请求过大使用 `-32602`；授权失败使用
`-32001`；领域错误、配额和 IO 失败使用 `-32000`。存储字段缺失报告
`plugin.api.missing:<field>`，类型错误为 `plugin.api.invalid:<field>`，键不合法为
`plugin.api.invalidStorageKey`，存储损坏为 `plugin.api.invalidStorage`，超配额为
`plugin.api.storageTooLarge`。`knownErrors` 列出已知标识，不穷举 IO 错误文字。
传输层可能以 `-32002` 拒绝过大的响应且不附带 `data`，因此调用方不能要求所有错误都有
`data`。请处理未知错误消息，不要依赖操作系统特定错误文字。

## 稳定的工作区快照

`workspace.snapshot` 需要 `workspace.read` 权限，自 0.21.0 起提供。冻结的
[工作区 v1 契约](../tests/fixtures/plugin-compat/workspace-v1.json)定义其只读结果。
该方法接受对象参数并忽略未知字段；返回当前 `tabs`、`panes`、`activeId`、
`activePaneId` 和递归的 `layout`。空工作区也有一个窗格和布局，当前标签可以是 `null`。

结果使用独立的协议数据结构，并逐字段投影和复制。内部状态后续新增的字段不会自动
暴露给插件，插件修改返回值也不会改变应用状态。快照只含布局和文件窗格元数据，
不含编辑器内容、草稿或凭据。返回的路径、主机和会话标识不授予文件或 SSH 权限。

- 标签保留 `id`、`kind`、`title`、可空的 `hostId`、`pinned`，以及原有可选字段
  `preview`、`hidden`、`filePane` 和可空的 `fileSessionId`。`kind` 是开放字符串，
  插件必须容忍不认识的标签类型。
- 文件窗格包含本地或远端 `source`、可空的 `path` 和 `ownerSessionId`，以及可选的
  `view`、`remoteIdentity` 和 `offline`。视图保留列顺序、列宽、布局、隐藏文件、
  文件夹优先、排序和分组设置。选项字符串是开放值；省略、`false` 和 `null` 含义不同。
- 窗格包含 `id`、`tabIds`、可空的 `activeId` 和可选的 `locked`。隐藏的面板标签
  可保留在原窗格中；它的存在不表示当前可见。布局节点是 `pane` 或递归的 `split`；
  `row` 为水平排列，`column` 为垂直排列，`ratio` 在 0 到 1 之间。

每次调用读取当时的状态；快照不保留路径、标签或会话，也不提供跨请求的原子性。
调用前必须通过运行实例与权限校验，撤销后不能继续读取。本方法不发送事件；
运行时失效、请求过期等错误遵循发现目录中的契约。工作区修改方法仍为实验接口。

SDK 的工作区类型声明由宿主的独立数据结构同步，检查模式验证声明漂移而不写文件。
CI 将真实前端响应交给 Rust 响应编码器，再用冻结结构和历史 SDK 检查，避免仅验证
手写结果副本。平台和实际插件的验收仍需单独进行。

## 稳定的编辑器缓冲区接口

冻结的[编辑器 v1 契约](../tests/fixtures/plugin-compat/editor-v1.json)定义两个方法，
使用独立的数据结构，不直接返回内部存储字段。

| 方法             | 权限           | 输入与返回值                                                                                                         |
| ---------------- | -------------- | -------------------------------------------------------------------------------------------------------------------- |
| `editor.active`  | `editor.read`  | `{}`；当前聚焦标签没有就绪编辑器时返回 `null`，否则返回 `{tabId, documentId, version, path, name, content, dirty}`。 |
| `editor.replace` | `editor.write` | `{tabId, documentId, version, text}`；核对文档身份和版本后返回 `{tabId, documentId, version, dirty}`。               |

快照读取已打开的缓冲区，包括未保存修改，不会重新读文件。加载中、读取失败、断线或
已关闭的编辑器返回 `null`。内容超过 128 KiB UTF-8 字节时报告
`plugin.api.frontend:editor.documentTooLarge`。当前标签指获得焦点的工作区标签；聚焦
其他面板后，不会自动继续将之前的编辑器视为当前文档。明确针对某份文档继续执行的
命令应保留该文档身份。

替换是一次可撤销的缓冲区操作，不会自动保存。内容改变时递增版本；内容相同则保持
版本和撤销历史不变。撤销与重做也会递增版本。用户编辑、重新加载、关闭再打开或
缓冲区不可用后，旧身份或版本不再有效，报告 `plugin.api.frontend:editor.documentChanged`。
插件应重新读取并让用户重试，不能覆盖更新的内容。`dirty` 比较替换后的内容和已保存
基线，不代表替换后一定为 `true`。

替换参数中的 ID 必须非空、不含 NUL，且不超过 1,024 个 UTF-16 码元；版本必须是
非负安全整数。文本允许为空，UTF-8 编码后最多 128 KiB。忽略未知输入字段，调用方也
必须忽略未来新增的返回字段。结构中的字符长度不能代替编码限制与运行状态校验。
字段错误使用 `plugin.api.frontend:invalid:<field>`，JSON-RPC 代码为 `-32000`；
授权失败仍为 `-32001`。共享前端桥错误还包括 `plugin.api.busy`、
`plugin.api.frontendTimeout`、`plugin.api.frontendClosed` 和 `plugin.api.requestExpired`。
这两个 RPC 不产生插件事件，也不会自动订阅缓冲区变化。

## 兼容性测试

CI 使用当前宿主的清单加载器和 JSON-RPC 生命周期运行固定保存的 v0.28.0 示例。
另有新编写的探针使用冻结的契约引入前 SDK，旁附来源提交和 SHA-256，用于验证当前宿主。
核心结构检查会校验真实存储结果、会话序列化和 JSON-RPC 错误，并拒绝契约收窄或权限变更。
编辑器检查执行真实缓冲区状态下的前端桥，将捕获的返回值和错误经过 Rust 回复编码，
校验冻结结构，再把合并后的响应交给历史 SDK 回放。
这些验证覆盖明确的核心范围，并不证明所有方法、权限、事件或存储数据迁移均兼容。
请在插件声明的最低应用版本及较新宿主上测试，处理方法不可用、授权变化和错误，不要
依赖未记录字段或固定的方法数量。市场 SDK 目录与 `api.describe` 可能因发布不同步而
存在差异。

## 授权与运行时边界

安装可执行插件后，插件保持停止状态。执行前，Tunnelde 会展示来源和声明的权限并请求
批准。批准与插件包的 SHA-256 指纹及权限绑定；文件变更或重新安装后需要重新批准。
使用系统已有 Node 的同意是另一项独立选择。应用不自带 Node；用户也可以明确选择可执行
文件或安装私有运行时。声明式主题和图标贡献不需要 Node。

Node 插件以当前用户的操作系统权限运行。清单权限约束宿主 API，**不是操作系统沙箱**，
不能阻止 Node 代码直接访问文件系统、进程或网络。受限模式阻止应用管理的可执行 Node 和
WASM 插件运行，并阻止其宿主 API 请求；它无法撤销任意代码之前写入的数据或启动的外部
进程。请只运行信任的发布者提供的插件。

启动时使用 `--safe-mode` 或 `--restricted-mode` 可在该进程中强制进入受限模式。该设置
会持久保存，仅移除参数不会自动重新启动插件。主机和会话快照不会返回已保存的 SSH 密码
或私钥；插件授权也不能替代 SSH 主机密钥验证。恢复行为、资源限制、WASM 限制及各平台
的启动方式请参阅详细指南。
