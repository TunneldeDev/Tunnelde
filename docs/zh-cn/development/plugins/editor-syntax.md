# 编辑器语法高亮

[English](../../../en-us/development/plugins/editor-syntax.md) · [编辑器命令](editor-plugins.md)

插件语法高亮为实验性功能。它为已打开的编辑器文档和文件源码预览中的代码着色，不装饰文件列表行，
也不会修改文档。CodeMirror 编辑器仍是唯一的编辑与无障碍输入面。宿主把经过校验的语义 token 转换为
CodeMirror `Decoration.mark` 范围；没有可用结果时保持普通无样式文本。

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

不超过 128 KiB UTF-8 的小文档直接发送源文本。更大的文档改用受限的可见窗口请求：宿主
提供准确的文档身份/版本及最多 32K UTF-16 的窗口，不发送完整源文本。提供者可通过现有
`editor.readRange` 接口读取该窗口，每次最多 16K UTF-16，并仍受同一 `editor.read` 权限约束。
窗口结果中的 token 相对窗口计算，由宿主转换为绝对偏移；不会提高 RPC 上限。

高亮在编辑后防抖，大文档只请求稳定后的可见窗口。它不是整文正确性声明：若注释或模板起始于
窗口之前，可能只能按可见片段判断。文档身份/版本、插件包、运行代次、权限或标签变化时，
请求会被取消或丢弃。提供者报错或超时时保留仍有效的颜色；没有有效结果时保持普通文本。

## 文件源码预览

快速预览、停靠预览和独立窗口预览共用语义 token 颜色及只读 CodeMirror 渲染层，
支持本地文件和 SSH 文件。Markdown 在“显示源码”模式下提供高亮；渲染视图保持原有展示方式。

预览复用已运行且已获授权的纯语法高亮命令。每次使用 `mode: "inline"` 发送最多
32K UTF-16 单元的文本片段，同时遵守现有的 128 KiB 源文本及 256 KiB 请求限制。
token 偏移相对该片段计算。预览文档标识是临时标识，**不属于编辑器缓冲区**：
提供者应直接分析传入的 `source`，不要对预览标识调用 `editor.readRange`。
遵守 inline 协议的高亮插件无需增加权限或重新发布。

邻近滚动复用缓冲范围；等待或未能获取替代结果时，保留原偏移处仍有效的颜色。
关闭或替换预览、停止提供者或撤销授权时，会取消或丢弃待处理结果。
独立窗口通过当前原生面板租约请求高亮，不会启动额外插件运行时。
面板移动时恢复选区和滚动位置，视图胶囊不传输源码或 token。

## 渲染与编辑保证

CodeMirror 宿主负责选择、光标、撤销/重做、输入法组合、行号、自动换行和浏览器原生滚动。
插件 token 不会替换文档文本或提供标记；装饰类使用宿主定义的 `cm-editor-token-*` 词汇，
强制颜色模式保持可读的系统文本。

Tunnelde-hub 中的 [`syntax-basic` 示例](https://github.com/TunneldeDev/Tunnelde-hub/tree/main/examples/syntax-basic) 是面向常见源码文件的
轻量分词器，不是完整语言解析器或语言服务器。需要精确语义的生产插件应使用真正的解析器实现
相同的受限语义 token 协议。
