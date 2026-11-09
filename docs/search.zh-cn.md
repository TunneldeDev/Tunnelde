# 搜索与筛选预设

内置列表搜索框右侧提供漏斗按钮。打开后可以查看支持的字段并插入预设，条件保留在
输入框中，可直接编辑。存在有效条件时漏斗高亮。“清除筛选，保留搜索文字”只删除
已识别的筛选条件；× 清空整个查询。选择预设后焦点回到输入框。

普通文字可与 `字段:值` 组合。一个条件中用逗号表示“或”，重复字段表示“且”。
使用 `-字段:值` 排除对应值。包含空格或逗号的值用双引号包裹，例如
`tag:"生产 东区"`。公共列表搜索接受可选的 `@` 前缀。未知字段及尚未填完的字段
前缀作为普通文字搜索。各列表支持的字段可以通过漏斗查看。

| 搜索位置         | 示例                                                        |
| ---------------- | ----------------------------------------------------------- |
| 主机及远端选择器 | `tag:production,staging user:deploy -is:favorite`           |
| 插件市场         | `tag:tools name:format author:publisher`                    |
| 当前文件夹       | `ext:json,md size:>10MiB modified:>=2026-11-01`             |
| 隐藏文件         | `is:hidden`，默认不显示隐藏文件时也可使用                   |
| 命令历史         | `command:git date:2026-11-09`                               |
| 可信主机         | `host:example port:22 algorithm:ssh-ed25519`                |
| 进程             | `user:root cpu:>10 memory:>100MB`                           |
| 输出             | `level:WARN,ERROR domain:plugins.network plugin:identifier` |
| 设置             | `@is:modified section:appearance id:monoFontSize`           |
| 聊天历史         | `name:部署 is:active date:>=2026-11-01`                     |
| 快捷键           | `@is:conflict @plugins:identifier`，保留快捷键专用语法      |

数值支持 `>`、`>=`、`<`、`<=`、`=`。文件大小支持十进制单位
`KB`、`MB`、`GB`、`TB` 以及二进制单位 `KiB`、`MiB`、`GiB`、`TiB`。
CPU 按进程列表显示的百分比比较。日期使用本地日历日期，格式为 `YYYY-MM-DD`。
页面已有的范围选择与文字筛选条件同时生效。

## 快速访问

按 F1 打开。用 `>` 查命令、`%` 搜内容、`@` 查已保存主机，不加前缀则查文件及
已打开的标签。漏斗预设随模式变化：

- 命令：`category:Plugins`、`plugin:identifier`、`id:app.restart`。
- 文件：`name:report ext:json,md -path:vendor`。
- 内容：`% Foo  Bar ext:ts path:src` 保留原文 `Foo  Bar` 中的两个空格，
  内容搜索原文至少需要两个字符。

文件条件在本地或远端遍历时应用，先筛选再计入结果上限及读取内容。内容搜索使用
已打开文档的未保存内容替代对应的磁盘内容。搜索仍受条目、结果、文件大小、深度和
时间上限约束，触及限制时显示部分结果提示。快速访问递归搜索仍跳过隐藏目录、构建
目录和链接；当前文件夹筛选可以通过 `is:hidden` 包含隐藏条目。
