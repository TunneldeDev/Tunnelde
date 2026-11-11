# Tunnelde

[Documentation / 文档](docs/README.md)

A desktop SSH and SFTP workbench for Windows, macOS and Linux.

面向 Windows、macOS 和 Linux 的桌面 SSH 与 SFTP 工作台。

**[English guide](README.en-us.md) · [简体中文指南](README.zh-cn.md)**

## Install

Download the installer for your platform from [GitHub Releases](https://github.com/TunneldeDev/Tunnelde/releases).
Windows uses `.exe`, macOS uses the matching Apple Silicon/Intel `.dmg`, and Linux offers AppImage or `.deb`.

从 [GitHub Releases](https://github.com/TunneldeDev/Tunnelde/releases) 下载对应平台的安装包。
Windows 使用 `.exe`，macOS 按芯片选择 `.dmg`，Linux 提供 AppImage 和 `.deb`。

Updates default to the stable channel. Beta is optional; Nightly is not published.
Built-in desktop features do not require Node. Executable Node plugins need an explicitly authorized runtime.

更新默认使用正式版渠道，可选公测版，不发布 Nightly。内置功能不需要 Node；可执行 Node 插件需要单独授权运行时。

## Workbench

Manage hosts, terminals, local and remote files, transfers, port forwarding and monitoring in a dockable workspace.
Extend it through marketplace plugins. Press **F1** for application and installed-plugin commands.

在可自由停靠的工作区管理主机、终端、本地与远端文件、传输、端口转发和性能监控。
通过插件市场扩展功能；按 **F1** 快速执行应用及已安装插件的命令。

See complete feature descriptions and current limits in [English](README.en-us.md#workbench) or [简体中文](README.zh-cn.md#工作台).

## Plugin ecosystem

Plugins can contribute commands, panels, themes, file tools and other integrations. The independent
[Tunnelde Hub](https://github.com/TunneldeDev/Tunnelde-hub) maintains marketplace packages.

插件可提供命令、面板、主题、文件工具等扩展；市场及插件包由独立的
[Tunnelde Hub](https://github.com/TunneldeDev/Tunnelde-hub) 仓库维护。

Read the plugin overview in [English](docs/en-us/guide/plugins.md) or [简体中文](docs/zh-cn/guide/plugins.md).

## Documentation

| Guide / 指南                                         | English                                             | 简体中文                                             |
| ---------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------- |
| Installation and overview / 安装与概览               | [English](README.en-us.md)                          | [简体中文](README.zh-cn.md)                          |
| File browser / 文件管理                              | [English](docs/en-us/guide/files.md)                | [简体中文](docs/zh-cn/guide/files.md)                |
| Settings and profiles / 设置与配置方案               | [English](docs/en-us/guide/settings.md)             | [简体中文](docs/zh-cn/guide/settings.md)             |
| Network, transfers and forwarding / 网络、传输与转发 | [English](docs/en-us/guide/network-storage.md)      | [简体中文](docs/zh-cn/guide/network-storage.md)      |
| Keyboard shortcuts / 快捷键                          | [English](docs/en-us/guide/shortcuts.md)            | [简体中文](docs/zh-cn/guide/shortcuts.md)            |
| Monitoring / 性能监控                                | [English](docs/en-us/guide/monitoring.md)           | [简体中文](docs/zh-cn/guide/monitoring.md)           |
| Updates / 更新                                       | [English](docs/en-us/guide/updates.md)              | [简体中文](docs/zh-cn/guide/updates.md)              |
| Plugin development / 插件开发                        | [English](docs/en-us/development/plugins/README.md) | [简体中文](docs/zh-cn/development/plugins/README.md) |
| Architecture / 架构                                  | [English](docs/en-us/development/architecture.md)   | [简体中文](docs/zh-cn/development/architecture.md)   |
| Troubleshooting / 故障排查                           | [English](docs/en-us/guide/troubleshooting.md)      | [简体中文](docs/zh-cn/guide/troubleshooting.md)      |

## Development

Contributions target `dev`; `main` contains stable releases. See [Contributing](CONTRIBUTING.md)
and development instructions in [English](README.en-us.md#development) or [简体中文](README.zh-cn.md#开发).

贡献目标分支是 `dev`，`main` 为稳定发布分支。开发依赖、运行与检查命令见上述指南。
Beta 版本限于 `beta.1`–`beta.9`，达到上限前应审查并发布正式版。

## License

[GNU GPL version 3 only](LICENSE) · [Third-party notices / 第三方声明](THIRD_PARTY_NOTICES.md) · [Citation / 引用信息](CITATION.cff)

Copyright © 2026 quyansiyuanwang (TunneldeDev).
