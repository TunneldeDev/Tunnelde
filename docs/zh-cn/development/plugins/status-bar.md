# 插件底栏 API

[English](../../../en-us/development/plugins/status-bar.md)

底栏 v1 从宿主 0.32.0-beta.1 起属于稳定的增量接口。兼容旧宿主时，先通过
`api.describe` 判断是否包含 `statusBar.set`。本次无需更改协议版本，原有
稳定核心接口的契约保持原样。

```js
await host.call("statusBar.set", {
  id: "connection",
  text: "已连接",
  alignment: "right",
  priority: 10,
  icon: "cloud",
  tooltip: "打开连接详情",
  command: "open-details",
});
await host.call("statusBar.remove", { id: "connection" });
```

插件在初始化处理函数中注册，状态变化时使用同一 ID 更新，无需打开插件页面。
可执行插件仍须获得用户批准；这两个接口不要求额外领域权限，也不授予文件、
网络或执行命令的权限。Node 插件使用用户的 Node 运行时仍须明确授权。

| 字段        | 契约                                                                                   |
| ----------- | -------------------------------------------------------------------------------------- |
| `id`        | 必填，1–128 个 ASCII 字母、数字、点、下划线、短横线；归属于插件本次运行                |
| `text`      | 必填，非空白纯文本，最多 128 个 Unicode 码点                                           |
| `alignment` | `left`（默认）或 `right`                                                               |
| `priority`  | −1000 至 1000 的整数，默认 0；按优先级降序，再按插件与项目 ID 排序；两组都从左向右排列 |
| `tooltip`   | 可选纯文本，最多 1024 个码点；宿主始终加上插件名称                                     |
| `icon`      | 可选 `activity`、`check`、`alert`、`info`、`sync`、`terminal`、`cloud`、`code`、`plug` |
| `command`   | 可选的本插件 manifest 命令；依赖编辑器或文件右键上下文的命令不适用                     |

更新时替换整个项目，不是局部合并。省略可选字段即可恢复默认值；tooltip、icon、
command 也接受 `null` 清除。为向前兼容，忽略未知字段。拒绝控制字符与双向覆盖字符，
不支持 HTML、CSS 和任意图片。

`set` 返回 JSON `null`；`remove` 返回本次运行的项目是否存在。
每个插件最多八项，所有插件合计最多 128 项。长文本采用省略号，提示和无障碍名称
保留插件身份。连接、任务、重启、安全和更新等内置入口保留各自位置，插件不能用
同名 ID 或优先级覆盖这些入口。

点击后执行已声明的命令，传入通常的 `_locale`，不自动打开结果标签页。
需要展示结果时使用插件视图或 `ui.showMessage`。执行期间禁用该按钮以防重复触发。
获得命令锁后重新校验批准、包指纹与运行代次，不会为了过期按钮重新启动已停用插件。

状态项仅在内存中存在。停止、崩溃、卸载、更新、撤销权限、进入受限模式或退出应用
都会清理；旧进程迟到的退出消息不会删除新进程的项目。WebView 重建后从宿主读取
快照；状态项不写入用户配置或 profile。v1 不新增面向插件的事件。

已知校验错误包括 `plugin.statusBar.invalidItem`、`plugin.statusBar.unknownCommand`、
`plugin.statusBar.limit`，以及通常的安全和 RPC 错误。过期 UI 点击返回
`plugin.statusBar.expired`。输入、结果和错误的机器可校验结构由 `api.describe` 提供，
同步到 SDK，并与冻结的 v1 样例比较。破坏兼容的变更需要新契约或明确迁移；
宿主内部的布局状态不属于公开接口。
