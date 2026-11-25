# 开发调试器适配

TunneldeDebugger 是独立的源码运行工作台。适配器复用生产 AppShell、控件和 Services；场景数据、预设、运行器编排及验收记录由调试器仓库维护。这是内部开发契约，与稳定本地 API 分开。

前端入口同时要求 `import.meta.env.DEV` 与 `VITE_TUNNELDE_DEBUGGER=1`。Rust 仅在 `cfg(all(feature="debugger", debug_assertions))` 下注册模块、命令及端点。运行时还要求 `TUNNELDE_DEBUGGER_ACTIVE=1`、`dev.tunnelde.debugtarget` 标识、独立数据/插件目录和匹配 UUID runId 的目录标记。凭据使用已有的应用标识专属 vault 命名空间。

`src/debugger/index.tsx` 通过受控、可变的 Services 数据渲染生产组件。未支持的操作明确失败。模拟文档使用内存存储，切换代次时重载以释放单例资源。内置合成插件示例不运行第三方插件代码。

`src/debugger/native.tsx` 还支持真实服务：后端准备主机和设置、临时本地文件、合成 SSH/SFTP 及正常工作区导航。两个文件面板初始均打开验收目录。SSH 服务只回显输入，不运行系统 shell；SFTP 适配器拒绝路径穿越和符号链接。操作者仍可使用正常生产文件导航。

独立 loopback TCP 端点发布私有描述文件，包含协议版本、地址、runId 和独立随机令牌，复用本地传输原语、容量和超时限制。登记命令提供能力发现、应用、快照/事件、检查和呈现，不执行 JavaScript 或转发任意 Tauri invoke。只有协调主窗口可轮询并确认渲染，请求及结果要求代次匹配。真实服务重置使用新进程/配置目录。原生所有权与窗口返回继续使用生产租约协议。

新增界面需同步调试器 `shared/scenarios.ts`、此适配器和 Rust 界面登记表。只有实际适配生产组件状态后才能声明支持对应预设。浏览器、原生界面模拟和真实服务结果必须可区分。修改边界后应验证类型、相关回归、启用/禁用 feature 的 Rust 构建及生产包排除。

使用调试器仓库 setup 命令在独立 worktree 应用固定基线的集成补丁，不覆盖开发者已有的未提交工作区。源码身份包含版本、工作区变更指纹及协议版本。截图属于目标窗口证据，自动检查不授予人工视觉通过结论。
