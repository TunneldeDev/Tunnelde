# 可选原生辅助程序

[English](../../en-us/development/native-helper.md)

可选的 `tunnelde-agent` 程序由独立仓库
[TunneldeDev/Tunnelde-agent](https://github.com/TunneldeDev/Tunnelde-agent) 维护。
其源码历史从桌面仓库原 `native-helpers/` 目录提取，有独立的版本、测试和发布流程，
桌面版发包不会再构建它或修改它的版本号。
普通 SSH、SFTP、终端、API 对话以及通过 SSH 直接运行 agent 不需要此程序。

需要 MCP stdio 或高级持久远端监督进程时，从该仓库的 Releases 下载对应二进制与
`SHA256SUMS`，核对 SHA-256 后再选择程序。远端运行选择远端机器的系统与架构。
macOS/Linux 下载后需执行 `chmod +x <文件>` 恢复执行权限。
辅助程序不包含 Node，也不会代替用户授权使用外部运行环境。

MCP 环境变量、监督进程部署、构建步骤及协议策略见辅助程序仓库的
[设置与兼容性说明](https://github.com/TunneldeDev/Tunnelde-agent/blob/main/README.zh-cn.md)。
本次迁移保留原有命令参数、runner 记录格式和协议行为。
不要替换正在运行的监督进程使用的二进制。

桌面安装器与桌面 Release 资产不包含辅助程序。旧版桌面标签仍包含当时的辅助程序源码，
历史快照保持不变。后续辅助程序修改与问题反馈应提交到独立仓库。
