# 编辑器命令与格式化插件

已安装的插件可以为当前编辑器提供命令和快捷键。点击工具栏的“格式化文档”，
或按 **F1** 搜索已安装的插件命令。插件可以声明默认快捷键；具体绑定请查看
**设置 → 键盘快捷键**。没有插件提供时不会注册格式化快捷键，配置方案会保留用户的调整。

插件安装或更新时，如果新增快捷键与已有命令冲突，可选择保留某一方、保留冲突，
或跳转到已筛选的快捷键设置。保留的冲突会以红色标出。在编辑器中，匹配当前文件
后缀的插件命令和适用的工作台命令会依次执行。保留冲突前请检查绑定：例如
`Ctrl+Shift+F` 已用于搜索工作区内容。

有多个匹配的格式化插件时先选择提供者。执行仍需经过插件权限与运行环境授权；
拒绝授权时不会发送文档内容。结果只替换尚未保存的缓冲区，可以一步撤销，保存由用户决定。
如果等待期间继续编辑、关闭后重开文档，或插件被撤销权限，过期结果会被丢弃。

## 声明方式（Tunnelde 0.29.0-beta.2 起）

```json
{
  "permissions": ["editor.read", "editor.write"],
  "engines": { "tunnelde": ">=0.29.0-beta.2" },
  "commands": [
    {
      "id": "format",
      "title": "Format document",
      "keybindings": ["Mod+Shift+F"],
      "editor": { "extensions": ["json"], "format": true }
    },
    {
      "id": "compact",
      "title": "Compact document",
      "editor": { "extensions": ["json"] },
      "keybindings": ["Mod+Alt+M"],
      "macKeybindings": ["Meta+Alt+M"]
    }
  ]
}
```

后缀不含开头的点，忽略大小写，可声明复合后缀。只有 `format: true` 的命令参与
“格式化文档”选择；其他编辑器命令通过 F1 和快捷键执行。命令收到
`{source, document: {tabId, documentId, version, path, name}, indent, _locale}`，
返回 `{text: string}` 或 `{error: true, text: string}`。`indent` 是字符串形式的
编辑器缩进宽度。插件返回文本，不应直接修改磁盘文件；宿主确认文档标识及版本未变化后，
才应用为一次可撤销编辑。

输入、输出文档均限制为 128 KiB UTF-8；序列化后的整个命令输入还需满足现有
256 KiB RPC 限制，其中包括 JSON 转义开销。无效或超限结果不会替换缓冲区。
纯文本转换无需文件系统、SSH、剪贴板或网络权限。

`keybindings` 和可选的 `macKeybindings` 各最多四组，支持 `Mod`、`Ctrl`、`Meta`、
`Alt`、`Shift`，配合字母、数字、功能键或 `Comma` 等命名键。`Mod` 在 Windows/Linux
对应 Ctrl，在 macOS 对应 Command。实际 AltGraph 输入和输入法组合输入不会触发命令。
保留冲突时，匹配的编辑器命令与工作台命令都可能执行。

## 宿主 API

- `editor.active`（`editor.read`）：返回已就绪的当前文档快照，无可用文档时返回 `null`。
  字段为 `tabId`、`documentId`、`version`、`path`、`name`、`content`、`dirty`，
  不包含 SSH 会话细节、已保存凭据或基准内容。
- `editor.replace`（`editor.write`）：参数 `{tabId, documentId, version, text}`，
  返回 `{tabId, documentId, version, dirty}`。替换可撤销，拒绝过期、已关闭、加载中或
  已断开的文档。内容不变时保留版本，实际修改后版本递增。

两个接口沿用已授权的前端桥接与运行代次校验，只操作打开的缓冲区，不读取任意文件。
协议仍为 API version 1，旧接口调用保持兼容。完整生成目录及 TypeScript 类型见独立市场 SDK。

[English](editor-plugins.en-us.md) · [插件开发](plugins.md)
