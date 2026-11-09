# 主机列表扩展

[English](plugin-host-list.en-us.md) · [扩展架构](plugin-extension-architecture.zh-cn.md)

主机装饰属于实验接口。使用前通过 `api.describe` 发现 `hostList.setDecorations`；
通过 `extensions.describe` 查询组合规则。两个装饰方法均需要 `hosts.read` 和
`workspace.write`，并要求插件已批准且正在运行。发现目录不授予这些权限。

```js
await host.hostList.setDecorations({
  id: "environment",
  priority: 10,
  decorations: [
    {
      hostId: savedHost.id,
      badge: "生产环境",
      description: "部署就绪",
      icon: "server",
      tone: "success",
    },
  ],
});
await host.hostList.removeDecorations("environment");
```

同一插件的同名集合整体替换旧集合；空 `decorations` 数组移除集合。
`setDecorations` 返回 null；`removeDecorations` 返回本次运行是否拥有并移除了对应集合。
集合 ID 为 1–128 个 ASCII 字母、数字、点、下划线或短横线。
优先级为 -1000 至 1000 的整数，默认 0。每个插件最多八组、所有插件共 128 组；
每组最多 256 个不重复的已保存主机。注册时主机必须存在；任一条无效会拒绝整个集合，
不替换之前的有效值。

`badge`、`description`、`tooltip` 是可选纯文本，分别最多 16、160、512 个 Unicode
码点。null 清除可选字段；拒绝空白文本、控制字符和双向覆盖/隔离字符。
每个主机至少有徽标、说明或图标之一。图标支持 `server`、`cloud`、`container`、
`database`、`globe`、`code`、`terminal`、`shield`、`key`、`activity`。
语义颜色为 `neutral`（默认）、`info`、`success`、`warning`、`error`。
此装饰接口不接受任意 HTML、CSS 或图片 URL。

优先级高的图标和说明分别生效；同优先级按插件 ID、集合 ID 的序号顺序排序。
徽标按该顺序组合，直接显示两个，其余显示数量并在提示中列出。提示保留插件身份。
主机名、地址、已有颜色标记和连接按钮由宿主管理。装饰不修改已保存主机，不写入
Profile；停止、崩溃、替换、卸载和撤权时清理。

已知错误为 `plugin.hostList.invalidDecoration`、`plugin.hostList.hostNotFound`、
`plugin.hostList.limit`，以及通常的授权和运行时错误。贡献不依赖前端页面存在；
WebView 重建后读取宿主快照。安全状态变化时先清空显示，再通过权威快照恢复，
忽略排队中的旧快照。

表格列及显示偏好见[主机列扩展](plugin-host-columns.zh-cn.md)，工作台提供者见[UI 提供者](plugin-ui-providers.zh-cn.md)。主机来源和连接所有权仍是独立能力。
