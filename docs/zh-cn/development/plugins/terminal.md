# 终端提供者（实验性）

可信前端可以声明 `provider: "terminal"` 的组件视图，需要 `ui.trusted`、
`sessions.read` 和 `ssh.exec` 权限。用户在设置的“界面提供者”中明确选择后生效，
安装不会自动替换终端。前端代码运行在宿主上下文中，不是沙箱；终端文字可能包含秘密，
`send`、`paste` 可以使用连接用户的权限执行命令。

```json
{
  "runtime": "frontend",
  "frontend": { "entry": "ui/index.mjs", "sdk": "^0.1.0" },
  "permissions": ["ui.trusted", "sessions.read", "ssh.exec"],
  "views": [{ "id": "terminal", "title": "终端", "kind": "component", "provider": "terminal" }]
}
```

这是 Manifest 片段，还需补齐常规标识和版本字段。使用
`context.views.register("terminal", View)` 注册组件。组件收到的
`FrontendViewProps.terminal` 属于当前终端会话。完整组合示例见
[英文文档](../../../en-us/development/plugins/terminal.md)。

必须同步挂载且持续保留唯一的 `terminal.Screen`。组件移动现有屏幕，保留 SSH、
缓冲区和渲染器；连接操作和恢复入口由宿主保留。遗漏、重复挂载、渲染失败、停止、
撤权或进入受限模式会恢复内置终端。外层使用有可用高度的弹性布局，终端按照实际尺寸适配。

`readState()` 返回独立、不可变的会话标识、标题、状态、修订号、尺寸和缓冲区快照。
状态为 `starting`、`ready`、`suspended` 或 `closed`。
`readLines({ revision?, offset? })` 读取解析后的文字，不返回原始控制序列。
默认从当前可视区域开始，每页最多 128 行、每行 4096 个 UTF-16 单元、整页 65536 个单元。
截断行有明确标记；页末不会为了凑满预算而切断下一行。`nextOffset` 是下一行或 `null`。
后续分页传入原修订号，遇到 `plugin.terminal.changed` 后从最新快照重新开始。
旧滚动内容仍会按终端设置淘汰。

`subscribe(callback, { signal? })` 每 100 毫秒合并变化通知，单终端最多 16 个订阅。
这是需要重新读取快照的变更提示，不是无损输出流。通知类型包括输出、选择、滚动、尺寸及状态。
调用返回的释放函数或中止信号可以退订；替换提供者、卸载和撤权时宿主也会清理订阅。
抛出异常的回调会被移除并写入软件日志。

`readSelection()` 最多返回 65536 个 UTF-16 单元并标记截断，不读取系统剪贴板。
`focus()`、`clearSelection()`、`scrollToLine(row)` 操作当前屏幕。
`paste(text)` 使用终端协商后的粘贴通道；`send(text)` 注入原始终端输入，
两者都不返回命令执行结果。输入必须非空且不超过 65536 个 UTF-16 单元，
尚未就绪、暂停或关闭时拒绝输入。远端关闭后，只要屏幕仍存在就可读取已解析文字。

上下文检查当前提供者、运行代次、指纹和授权；替换或关闭后，保存的旧引用不可继续操作。
这些检查不能沙箱化可信代码，也不能撤销已发送的命令。本能力不需要系统 Node。

这是实验性 UI SDK 的新增能力，不代表终端／历史整个领域已经稳定，也不提供原始输出录制接口。
