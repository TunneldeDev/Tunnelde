# 编辑器语法高亮

[English](../../../en-us/development/plugins/editor-syntax.md) · [编辑器命令](editor-plugins.md)

插件语法高亮为实验性功能。它只为已打开的小型编辑器文档中的代码着色，不装饰文件列表行，
也不会修改文档。原生 textarea 仍是唯一的编辑与无障碍输入面。宿主把经过校验的语义 token
渲染到 `aria-hidden`、不接收指针事件的覆盖层；没有可用结果时直接显示普通文本。

## Manifest 声明

命令使用 `editor.syntax: true` 声明其支持的扩展名。仅语法高亮命令需要 `editor.read`，
不需要 `editor.write`：

```json
{
  "permissions": ["editor.read"],
  "commands": [
    {
      "id": "highlight",
      "title": "Highlight source",
      "editor": { "extensions": ["ts", "tsx"], "syntax": true }
    }
  ]
}
```

权限规则保持保守：

| 编辑器声明                            | 所需权限                      |
| ------------------------------------- | ----------------------------- |
| `syntax: true`，无 `format`           | `editor.read`                 |
| `format: true`                        | `editor.read`、`editor.write` |
| 旧式编辑器命令，无 `syntax`           | `editor.read`、`editor.write` |
| 同时 `syntax: true` 与 `format: true` | `editor.read`、`editor.write` |

宿主选择第一个匹配的纯语法提供者。高亮**不会**自动启动插件，也不会自动弹出授权窗口。
只有该提供者已经运行并已有 `editor.read` 授权时才会调用；否则编辑器保持普通文本，
用户需自行明确启动或授权插件。

## 命令协议

输入：

```json
{
  "source": "const answer = 42;",
  "document": {
    "tabId": "editor:...",
    "documentId": "...",
    "version": 3,
    "path": "/project/main.ts",
    "name": "main.ts"
  },
  "extensions": ["ts"],
  "_locale": "zh-CN"
}
```

输出：

```json
{
  "tokens": [
    { "start": 0, "end": 5, "type": "keyword" },
    { "start": 15, "end": 17, "type": "number" }
  ]
}
```

偏移是以 UTF-16 代码单元计的半开区间，必须位于输入 `source` 范围内、不能切开代理对，
且必须升序、互不重叠。每次结果最多 16,384 个 token、序列化后 128 KiB。类型仅限
`keyword`、`string`、`number`、`comment`、`type`、`function`、`property`、`operator`、
`punctuation`、`variable`、`constant` 和 `invalid`。颜色由宿主主题决定；插件提供的 HTML、
CSS、类名或任意属性会被拒绝。

源文本与请求上限分别为 128 KiB UTF-8 和 256 KiB 序列化大小。更大的文档保持普通文本，
不会发送高亮请求。编辑后使用防抖调用；文档身份/版本、插件包、运行代次、权限或标签变化时，
请求会被取消或丢弃。提供者报错或超时也回退为普通文本。

## 渲染与编辑保证

原生 textarea 保留选择、光标、撤销/重做、输入法组合、自动换行和浏览器滚动。覆盖层匹配
textarea 的字体、字号、行高、Tab 宽度、内边距、换行模式和可视区域，并同步水平/垂直滚动。
输入法组合期间隐藏覆盖层，避免组合文字透明或重影；强制颜色模式下也显示原生文本。

附带的 [`syntax-basic` 示例](../../../../examples/plugins/syntax-basic/README.md) 是面向常见源码文件的
轻量分词器，不是完整语言解析器或语言服务器。需要精确语义的生产插件应使用真正的解析器实现
相同的受限语义 token 协议。
