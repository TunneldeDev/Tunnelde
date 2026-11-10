# 快捷搜索结果提供者

[English](plugin-quick-access-ui.en-us.md) · [界面提供者](plugin-ui-providers.zh-cn.md)

组件视图声明 `provider: "quickAccess"`、可信前端及 `ui.trusted`、
`hosts.read`、`sessions.read`、`fs.read`、`sftp.read`、`workspace.read`、
`editor.read` 权限。用户在设置中明确选择后生效。元数据检索不会启动贡献命令
的插件，也不会默认使用用户 Node。

`props.quickAccess.snapshot` 是不可变的实验性 DTO，描述模式、查询、根目录、
选择、总数、搜索状态及错误。支持 `>` 命令、`%` 内容、`@ ` 主机及文件搜索；
字段筛选必须以 `@` 开头。描述中的路径和会话不代表资源授权。

通过 `read({ revision, offset? })` 读取已收集的结果。每页最多 128 条，
`items` 数组序列化后不超过 65,536 UTF-16 单元。结果键只在该修订中有效。
文本可能截断，`truncated` 会标明。原生列表每页显示 100 条，不再静默丢弃
后续命令、主机和标签。文件遍历和未保存内容合并仍有独立上限，通过 `limited`、
`skipped` 和宿主说明展示；分页不代表无限搜索磁盘。

`setQuery` 最多接受 4096 UTF-16 单元；`select` 选择当前结果。`invoke` 还要求
`workspace.write`，将选择交给原生命令分派，包括其原生确认和目标插件授权。
该权限允许工作台交互，不绕过目标插件审批。查询变化、关闭重开、目标编辑
或连接变化后旧动作被拒绝；启动授权后仍核对原插件包及贡献。打开结果会关闭
面板，同次打开不能重复执行。

可选 `Entries` 至多挂载一次，复用原生图标、快捷键、选择和条目 DOM。
省略它不停止搜索。输入、漏斗、根目录、分页、错误、Escape 和恢复入口归宿主。
崩溃、重复挂载、撤权或停用会回到原生表现。可信前端共享宿主上下文，不是沙箱。

公开契约按 `contracts/search/quickAccess/{entry,provider}` 分类，私有适配按
`extensions/search/quickAccess/{projection,context,provider}` 分类，功能实现
区分 `data/`、`runtime/`、`components/`。旧组件入口只保留兼容导出。
此能力仍是 experimental；插件依赖图和完整激活编排仍需单独完善。
