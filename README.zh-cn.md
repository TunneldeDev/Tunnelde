# Tunnelde

[English](README.en-us.md)

面向 Windows、macOS 和 Linux 的桌面 SSH 与 SFTP 工作台，由
**quyansiyuanwang / TunneldeDev** 维护，采用 Tauri 2、Rust、React 和 TypeScript 构建。

## 安装

从 [GitHub Releases](https://github.com/TunneldeDev/Tunnelde/releases) 下载桌面安装包。

| 平台                              | 下载格式                               | 更新方式                              |
| --------------------------------- | -------------------------------------- | ------------------------------------- |
| Windows 10/11 x64                 | NSIS `.exe`                            | 应用内更新                            |
| macOS 12+，Apple Silicon 或 Intel | 对应架构的 `.dmg`                      | 当前未签名，手动使用 DMG 更新         |
| Linux x64                         | AppImage 或 `.deb`，需要 WebKitGTK 4.1 | AppImage 支持应用内更新，deb 手动更新 |

按 **F1** 打开快速访问：`>` 列出应用和已安装插件的命令，`%` 搜索选定本地或 SSH 目录中的文件内容，
`@` 查找主机。**Ctrl/Cmd+P** 打开文件或已有标签页。已安装插件的命令可以直接执行，也可在
“设置 → 快捷键”中绑定按键。本地和远端文本结果都在编辑器中定位到匹配行，保留未保存的文字；其他受支持的
文件类型在预览中打开。搜索采用字面匹配，有范围限制，并支持取消。

桌面内置的 SSH、SFTP、监控、设置和主题包**不自带，也不要求 Node**。可执行 Node 插件需要单独选择运行时；
发现或使用系统 Node 前，应用会先请求授权。Windows 和 macOS 安装包目前没有平台代码签名。

在**设置 → 更新**选择正式版或公测版，以及 GitHub 官方源或兼容的自定义 HTTPS 更新源。所有安装的默认渠道
均为正式版，包括公测版安装。默认每天自动检查一次，下载和安装仍由用户手动触发。Windows 和 AppImage
使用带更新签名的完整安装包。切换到正式版不会自动将较新的公测版降级。镜像及渠道要求见
[更新发布说明](docs/releases.zh-cn.md)。

## 工作台

- 组织、搜索、标记、收藏和拖动排序主机。在搜索框使用 `tag:PublicNet`、`@tag PublicNet`、带引号的标签或
  `is:favorite` 筛选；可以用鼠标或方向键与 Enter 选择标签建议。支持密码、密钥文件和粘贴私钥连接，
  可在编辑主机时保存密码，双击直接连接。未知或变更的主机密钥仍需要明确确认信任。
- 终端基于 xterm.js，支持 ANSI 颜色、Unicode 字素宽度、等宽字体、原生剪贴板、可配置鼠标行为和实时命令历史。
- 本地和远端文件视图相互独立，提供详情和 Finder 分栏视图。可展开路径层级、编辑完整路径、输入名称定位、
  调整宽度或分离面板。支持排序、筛选、分组、行内重命名、新建文件和文件夹，直接连接文件管理及拖拽传输。
  选中文件后按空格或点击预览，查看本地和远端文本及渲染后的 Markdown。兼容的图标与预览提供者可扩展文件类型；
  安装前请查看其运行时和权限要求。媒体播放能力取决于操作系统编解码器。
- 为各功能配置代理，通过有序 SSH 跳板机连接；暂停和恢复传输，查看速度、剩余字节及预计时间；从活动栏、
  主机详情或终端工具栏管理本地和远程 TCP 转发。移除未完成任务会清理其记录的暂存文件，离线清理在重连后重试。
  状态栏的后台任务入口提供分组任务、展开详情和临时限速；任务列表可移动、调整大小并保留布局。
  优化传输采用有界 SFTP 请求流水线、自动分块和共享连接预算；在兼容的 SSH 主机上使用自适应压缩和
  有界内存归档减少小文件传输的往返请求。
  行为与限制见[网络与存储](docs/network-storage.zh-cn.md)。
- 将标签和侧栏面板拖入任意分栏。单击页面和插件详情时打开可替换的斜体预览标签；再次选择、双击标签或与
  页面控件交互后保留该标签。每个分栏有独立的预览标签。可锁定新页面的默认目标分栏，并收起、恢复停靠面板，
  保留位置和尺寸。
- 查看远端 CPU、内存、网络和磁盘读写时间轴，使用刻度、时间戳及鼠标或键盘检查采样。结束进程需要确认。
- 自定义主题、颜色、字体、终端行为和快捷键。导出设置及切换配置方案时，不导出主机或凭据。
- 在**设置 → 高级 → 存储位置**分别或批量迁移设置/数据库、插件包及其数据、托管密钥和运行时、缓存、日志及
  部署记录。先检查目标目录，再完全退出并重新打开应用以生效；切换前验证副本，保留原数据用于恢复。
- 选择系统或紧凑标题栏。关闭到托盘时默认释放 WebView，原生 SSH 会话和传输继续运行，重开恢复工作区、
  终端画面及未保存的草稿。轻量模式可减少终端 GPU 渲染、目录预加载和监控采样；macOS 可配置后台 Dock 图标。
  使用“退出”完全结束应用。

## 插件生态

独立的 [Tunnelde Hub](https://github.com/TunneldeDev/Tunnelde-hub) 仓库维护插件市场和插件包。
插件可提供命令、面板、主题、文件工具、AI 助手等扩展。请浏览市场，并查看各插件的能力、运行时要求和权限。

兼容的助手集成可在本地或已连接的 SSH 主机运行，初始化、认证、审批策略和保障能力因插件和执行位置而异，
详见[助手指南](docs/ai-assistants.zh-cn.md)。可执行插件权限不等于对任意代码或 shell 命令提供操作系统沙箱。
使用系统 Node 运行时需要明确授权。

可选的 `tunnelde-agent` 用于 MCP stdio 和高级持久远端 supervisor，由独立的
[Tunnelde-agent 仓库](https://github.com/TunneldeDev/Tunnelde-agent) 维护源码与下载，并采用独立发布周期。
普通 SSH 和通常的远端 CLI/助手连接不需要安装它。

## 文档

- [文件浏览、列布局及键盘导航](docs/files.zh-cn.md)
- [设置与配置方案](docs/settings.zh-cn.md)
- [代理、跳板机、传输及 SSHFS](docs/network-storage.zh-cn.md)
- [键盘与鼠标快捷操作](docs/shortcuts.zh-cn.md)
- [AI 本地与远端配置](docs/ai-assistants.zh-cn.md)
- [插件概览与兼容性](docs/plugins-overview.zh-cn.md)
- [插件开发与安全](docs/plugins.zh-cn.md)
- [架构与数据位置](docs/architecture.zh-cn.md)
- [故障排查](docs/troubleshooting.zh-cn.md)
- [可选原生辅助程序](docs/native-helper.zh-cn.md)
- [版本变更](CHANGELOG.md)

各指南均提供对应的英文版本。

## 开发

开发需要 Rust 1.92+、Node 24+、pnpm 10+ 及相应平台的 WebView 构建依赖；这些依赖面向贡献者，普通桌面用户
不需要安装。

```sh
pnpm install --frozen-lockfile
pnpm tauri dev
```

提交前运行相应检查：

```sh
pnpm check
pnpm i18n:check
pnpm version:check
pnpm build
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
```

源码布局：

```text
src/                 React 工作台、UI 组件、功能状态和国际化
src-tauri/           Rust SSH/SFTP 核心、插件 API、原生集成和更新器
examples/plugins/   最小插件示例
scripts/            构建、验证、打包与发布工具
docs/               用户和开发者文档
```

市场位于独立的 `TunneldeDev/Tunnelde-hub` 仓库。CI 验证前端、原生应用和仓库检查。
`dev` 是受保护的默认贡献分支，`main` 为稳定发布分支，PR 标题采用 Conventional Commit 格式。

`dev` 更新后运行 CI，并维护一个指向 `main` 的发布 PR，归总下一版版本号、清单和 CHANGELOG。
普通功能 PR 无需修改版本号。公测版及正式版由不可变的 `v*` 标签发布，名称带完整版本号。
在 Actions 运行 **Prepare Beta** 选择当前 dev 快照并分配下一个 `beta.N`；公测版本仅允许 `beta.1`–`beta.9`，
序号用尽前应审查并晋升正式版，不重复使用公开标签。Nightly 已停止发布；开发测试使用 `pnpm build:local`，
不会创建公开版本或消耗公测序号。

自动发布 PR 使用 **Create a merge commit** 合并，保留 dev 提交历史，再为审查后的 main 源码创建标签，
分发 Windows、Linux、Apple Silicon 和 Intel macOS 包。各渠道在安装包、签名及更新元数据验证完成前保留为
草稿；公测版最终发布为 Pre-release，保留历史版本并且不会替换最新正式版。

PR 约定见[贡献说明](CONTRIBUTING.md)，分支保护、自动化凭据和构建恢复见[发布指南](docs/releases.zh-cn.md)。
`pnpm build:local` 生成未签名的本地构建，无需更新签名密钥。

## 许可

引用信息见 [CITATION.cff](CITATION.cff)。

[GNU GPL version 3 only](LICENSE)，另见[第三方声明](THIRD_PARTY_NOTICES.md)。
Copyright © 2026 quyansiyuanwang (TunneldeDev)。
