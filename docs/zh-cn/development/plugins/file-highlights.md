# 文件列表高亮

[English](../../../en-us/development/plugins/file-highlights.md) · [文件浏览器数据](file-browser-data.md)

文件列表高亮属于实验接口。使用前通过 `api.describe` 发现
`fileList.setHighlights`。注册需要 `fileBrowser.read`、`workspace.write` 权限，并要求插件已批准且
正在运行；该接口不会读取文件内容，也不会额外授予文件系统访问权。

```js
await host.call("fileList.setHighlights", {
  id: "generated",
  priority: 10,
  source: "local",
  highlights: [
    { match: { extension: "ts" }, tooltip: "生成的源码", tone: "info" },
    { match: { pathPrefix: "/tmp/generated/" }, tooltip: "临时输出", tone: "warning" },
  ],
});
await host.call("fileList.removeHighlights", { id: "generated" });
```

同一插件的同名集合整体替换旧集合；空 `highlights` 数组移除集合。
`setHighlights` 返回 JSON `null`；`removeHighlights` 返回本次运行是否拥有并移除了
对应集合。

| 字段        | 契约                                                                      |
| ----------- | ------------------------------------------------------------------------- |
| `id`        | 必填，1–128 个 ASCII 字母、数字、点、下划线或短横线；归属于插件本次运行   |
| `priority`  | −1000 至 1000 的整数，默认 0；优先级高者生效                              |
| `source`    | `local`、远端会话 ID（可写作 `remote:<id>`），或省略/空字符串表示所有来源 |
| `directory` | 可选，集合只作用于完全匹配的列表目录路径                                  |
| `match`     | `name`、`extension`、`pathPrefix` 中必须且只能提供一个                    |
| `tooltip`   | 可选纯文本，最多 512 个 Unicode 码点                                      |
| `tone`      | `neutral`（默认）、`info`、`success`、`warning` 或 `error`                |

`name` 是区分大小写的完整文件名；`extension` 不区分大小写且不带前导点；
`pathPrefix` 按原样匹配路径前缀。目录不会匹配 `extension` 规则。来源专属规则优先于
全局规则，其余按优先级、插件 ID、集合 ID 和规则顺序决定胜出项。

宿主负责绘制语义色左边标记、背景淡色及图标/名称颜色；插件不能提交 CSS、HTML、
任意颜色或图片 URL。首个匹配规则作为视觉结果，提示和无障碍名称包含插件身份。
高亮不会选中文件、修改文件元数据、写入 Profile 或影响文件操作。停止、崩溃、更新、
撤权、受限模式或应用重启时清理。

每个集合最多 256 条规则和 256 KiB，每个插件最多 8 个集合，所有插件共 128 个。
无效批次整体拒绝。已知错误为 `plugin.fileList.invalidHighlight`、`plugin.fileList.limit`，
以及通常的权限和运行时错误。
