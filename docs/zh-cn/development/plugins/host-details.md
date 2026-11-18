# 主机详情扩展

插件可在主机详情页插入可交互组件，包括卡片、编辑器和操作按钮。它与保存标量字段的
`hostFields` 独立，使用已有可信前端模块与 `context.api.call`；每个操作仍遵守相应 API 的权限。

```json
{
  "frontend": {"entry": "ui/index.mjs", "sdk": "^0.1.0"},
  "permissions": ["ui.trusted", "hosts.read", "mounts.read", "mounts.hostDetails"],
  "views": [{"id": "mounts", "title": "挂载", "kind": "component"}],
  "hostDetails": [{"id": "mounts", "title": "挂载", "viewId": "mounts", "kind": "mounts"}]
}
```

`hostDetails` 每插件最多 8 项；`id` 唯一，`viewId` 必须引用本插件未作为 provider 的组件视图。
所有板块需要 `ui.trusted`、`hosts.read` 和 `frontend` 声明。普通板块省略 `kind`，依插件 ID
排序追加到已保存主机的详情页。`kind: "mounts"` 额外需要 `mounts.read`、`mounts.hostDetails`。
注册贡献点不会自动启动插件，也不会自动授权写操作。

前端通过 `context.views.register(viewId, Component)` 注册组件；宿主传入
`props.hostDetails = {hostId, contributionId, kind?}`。主机切换会销毁旧组件和它的
`props.resources`；插件停止、替换、撤销授权或受限模式会移除板块。

在设置的插件界面提供者区域选择「主机挂载」。设置字段
`mountHostDetailsSelection: {pluginId, contributionId} | null` 对应宿主类型
`MountHostDetailsSelection`。同一时间只显示一个挂载贡献者；切换只改变界面，
不应复制规则、停止后台连接或修改运行状态。`settings.get`/`settings.update` 也能读取和修改此选择，
分别要求 `settings.read`/`settings.write`。恢复内置工作区会同时清除此选择。

发现支持情况使用 `extensions.describe().hostDetails`。不要根据版本号猜测功能，也不要把
`hostFields` 当作交互表单或渲染任意 HTML 的入口。

# 板块操作与 API

插件调用与宿主界面应共享领域服务。新功能的读取、修改、启停、批量操作和状态观察应同步开放，
并通过 `api.describe` 发布真实实现的方法与权限。UI 贡献点负责呈现，操作调用公开 API。

| 板块 | API / 贡献点 |
| --- | --- |
| 主机与分组 | `hosts.*`、`groups.*`、`hostList.*`、`hostDetails` |
| SSH 会话与终端 | `sessions.*`、`terminal.*` |
| 文件面板与预览 | `files.*`、`fileBrowser.*`、`fileList.*`、`filePreview.*` |
| 文本编辑 | `editor.*`、`files.content.*` |
| 转发 | `forwards.*`、`forwards.automation.*` |
| 挂载 | `mounts.*` |
| 监控与命令历史 | `monitor.*`、`history.*` |
| 工作区与底栏 | `workspace.*`、`statusBar.*`、`tabBar.*` |
| 设置与配置方案 | `settings.*`、`preferences.*`、`profiles.*` |
| 任务、存储、日志与工具 | `tasks.*`、`runners.*`、`resources.*`、`storage.*`、`logs.*`、`tools.*` |

`forwards.automation.list` 返回原生面板相同的规则、revision、自动启动/重试选项和恢复状态；
`forwards.automation.save({id, expectedRevision, automation:{autoStart,autoRetry}})` 按精确
revision 保存选项。旧的 `forwards.list`/`forwards.save` 契约不变。自动化设置属于持久宿主配置，
停止插件不会撤销已保存的设置；自动启动在下次启动应用时生效，保存选项不会立即建立连接。
