# 进程管理提供者

[English](../../../en-us/development/plugins/processes-ui.md) · [界面提供者](ui-providers.md)

组件视图声明 `provider: "processes"`、可信前端及 `ui.trusted`、
`sessions.read`、`monitor.read` 权限。用户在设置 → 插件 → 界面提供者中选择。
此扩展属于实验性 UI SDK 的增量能力，不改变既有稳定 RPC 或协议版本。

`props.processes.snapshot` 包含连接身份、查询、排序、选择、数量、采样状态、
更新时间和错误。`read({ revision, offset })` 返回独立复制、冻结的数据；每页
最多 128 条，items 数组序列化后最多 65536 个 UTF-16 单元，包含 JSON 转义。
文本有长度限制，`truncated` 表示字段被截短。未知或无效指标为 `null`，不当作零。
CPU 总量按主机容量归一化；`cpuPerCore` 可以超过 100%。网络、磁盘和 GPU
数据取决于远端采集工具与权限。

`setQuery`、`setSort`、`select`、`refresh` 和 `setPaused` 操作原生界面所用
的同一宿主服务。字段筛选只接受 `@name:`、`@pid:`、`@user:`、`@group:`、
`@cpu:`、`@memory:`；没有 @ 的 `name:` 保持普通文本含义。
记录 key 是当前修订内的不透明标识。动作要求当前连接、视图和已提交修订有效。
提供者代次撤销前仍可读取保留的不可变快照；切走再切回不能复活旧代次。

可选 `Entries` 至多挂载一次，复用原生表格、分页、选择和详情。恢复时移动
相同 DOM 节点。省略它不会停止采样。标题、关闭、刷新、暂停、错误、确认和
恢复入口由宿主保留。渲染失败或重复挂载会恢复原生界面。可信前端共享宿主
上下文及原生桥，这些 SDK 检查不是针对恶意 JavaScript 的沙箱。

采样按连接共享，每次完成后安排下一次。暂停某个消费者会停止它的自动请求
需求，其他已打开的消费者仍可刷新共享数据；暂停时可以手动刷新。
应用窗口隐藏时暂停采样。最后一个所有者关闭后，迟到结果退役；重新打开须
等待旧 SSH 请求结束后再采样。这是协作式资源归属，不会中止已经运行的远端采集。

`capabilities.terminate` 需要额外的 `monitor.write`。调用
`requestTerminate({ revision, key })` 请求原生确认；用户确认时重新检查
当前提供者权限、运行代次、连接和进程身份。每个确认只消费一次，执行尚未
结束时也不能重复提交。关闭视图或 PID 复用会使操作失效。
后端在发送 TERM 前核对 Linux 进程启动 ticks，降低误操作复用 PID 的风险。
Shell 校验与发送信号不是内核原子进程句柄，也不保证进程立即退出。
既有 `monitor.kill` RPC 保留原有行为，与此确认式 UI API 不同。

公开契约位于 `contracts/monitor/processes/{entry,query,provider}`；私有投影、
上下文和授权位于 `extensions/monitor/processes/`。功能目录继续区分 `data/`、
`runtime/` 和 `components/`，内部进程身份归宿主管理。插件代码和生成的 SDK
声明不依赖内部状态或功能模块。

## 原生进程操作

共享 Entries 支持右键及 Shift+F10 菜单：详情、打开远端可执行文件目录、结束和结束进程树。树操作明确确认后按子到父发送 TERM；逐项核对启动 ticks 与父 PID，并保护操作通道及其祖先。进程消失或 PID 复用时不继续操作；权限不足或不存在可执行文件时显示错误。

新增实验 RPC `monitor.killTree({sessionId,pid,expectedStartTicks})` 需要 `monitor.write`；`monitor.executable` 同参数需要 `monitor.read` 并返回远端绝对路径。两者保留 native origin 和会话所有权检查；旧 `monitor.kill` 契约不变。文件目录使用同一会话的文件浏览器打开，不交给本机文件管理器。

“运行新任务”在同一共享工具栏提供 Shell 命令与可选绝对工作目录，保留错误及提交 PID，支持键盘和焦点回退。命令在远端以 SSH 用户通过 `nohup sh -c` 后台运行，无终端、输入输出丢弃，不自动提权。目录留空使用登录目录；命令与目录独立引用，不将目录拼入命令语法。PID 只表示提交，不能作为成功完成证据。实验 RPC `monitor.launch({sessionId,command,cwd})` 需要 `monitor.write` 和 `ssh.exec`，返回 PID；有长度、空值、NUL 和目录校验。
