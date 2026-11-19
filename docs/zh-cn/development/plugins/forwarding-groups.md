# 转发组与主机迁移 API

通过 `api.describe` 发现这些实验性接口。Node 使用 `host.call`，组件使用 `context.api.call`。

## 转发组和专用连接

`forwards.automation.list` 返回规则的 `revision`、可空 `groupId`、自动启动/重试配置和运行状态。
旧 `ForwardRule` 请求体与 `forwards.list` 响应结构不变，旧规则默认未分组。

| 接口                        | 权限             | 参数                                  |
| --------------------------- | ---------------- | ------------------------------------- |
| `forwards.groups.list`      | `forwards.read`  | `{hostId?}`                           |
| `forwards.groups.save`      | `forwards.write` | `{hostId,name,id?,expectedRevision?}` |
| `forwards.groups.remove`    | `forwards.write` | `{id,expectedRevision}`               |
| `forwards.move`             | `forwards.write` | `{id,expectedRevision,groupId?}`      |
| `forwards.startManaged`     | `forwards.write` | `{id,expectedRevision}`               |
| `forwards.startManyManaged` | `forwards.write` | `{items:[{id,expectedRevision}]}`     |

组读取/保存返回 `{id,hostId,name,revision}`。不传 `id` 创建新组，重命名必须传当前 revision。
每台主机最多 32 组、全局 512 组。移动必须先停止规则，并选择同主机下的组；省略或传空 `groupId`
可移到未分组。移动更新规则 revision，保留自动启动/重试设置。只有空组可删除。

宿主统一管理原生界面、自动启动/重试和插件启动的连接池。同组共享一条专用 SSH 连接，
不同组和每条未分组规则各用独立连接。同一已审核路由及组的并发连接请求合并；监听器持有连接，
最后一条停止后释放。组内旧连接仍有效时修改连接配置，新启动返回
`forward.groupConnectionChanged`；停止组内全部规则后才能使用新路由。路由、凭据和主机密钥仍正常检查。插件管理式启动只使用已保存凭据及已信任密钥，
缺少时返回错误，不弹凭据框，也不返回秘密。监听器仍归插件运行实例持有；撤销插件仅停止它拥有的监听器，
不会断开同组其他拥有者的监听器。

`startManaged` 成功返回 null。`startManyManaged` 接受 1–16 个不同的规则 ID，按输入顺序启动，
共用 90 秒预算，逐项返回 `started`、`failed`（含错误）或 `notStarted`。单项失败不回滚先前成功项。

旧 `forwards.start/startMany` 保留 `sessionId` 参数，但只能使用当前规则所属组/独占规则及当前
已审核路由的宿主管理连接。终端、其他组及插件自行创建的连接返回 `forward.sessionScope`。
新接入请使用管理式启动接口。配置及运行变化沿用 `forwards` 失效通知域。

## 主机配置迁移

`hosts.transfer.export({ids})` 返回 `tunnelde-hosts` 第 1 版文档，包含所选根主机及依赖闭包：
主机、祖先目录、明确的有效代理、跳板、转发组/规则、挂载组/规则。排除密码、私钥路径及内容、
令牌、会话和任意插件存储。

`hosts.transfer.preview({document})` 返回 `{revision,entries,document}`。条目包含
`id/name/address/conflict/dependency/requires/forwards/mounts`。名称去除首尾空白并忽略大小写；
地址忽略大小写与末尾点，与端口及用户名一起判重。不覆盖已有配置。

`hosts.transfer.apply({request:{document,revision,selected,copies?,mountPoints?}})`
以单个事务创建所选主机及必需跳板，生成新 ID 并重映射全部关联。默认拒绝冲突；明确传
`copies:true` 才新建副本。`mountPoints` 将导出规则 ID 映射至新设备的本地挂载点。
预览过期或本地挂载点无效会拒绝整个导入，刷新预览后再次检查冲突。新设备需重新配置凭据与密钥文件；
系统代理采用新设备环境。导入不连接、不启动规则。转发自动启动在下次应用启动生效；
挂载的 autoMount 仍是显式连接并启动自动规则时使用的选择标记。

导出/预览需要 `hosts.read/forwards.read/mounts.read/settings.read`；
应用导入需要 `hosts.read/hosts.write/forwards.write/mounts.write/settings.write`。
原生文件最多 4 MiB、含依赖最多 500 台主机；插件 RPC 继续使用更小的请求/响应限制，较大配置请分批处理。
这些插件接口不弹出文件选择框。
