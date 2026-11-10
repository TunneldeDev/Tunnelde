# 后台任务扩展

[English](plugin-background-tasks.en-us.md) · [界面提供者](plugin-ui-providers.zh-cn.md)

实验性的可信前端 SDK 将插件自己的任务执行和跨功能的任务展示分开。这些接口与
`tasks.*` 进程 RPC 命名空间不同，也不授予文件、网络或命令权限。

使用可选的 `ctx.backgroundTasks?.run(options, work)` 包装本插件的协作异步工作。
宿主分配 `pluginId`，插件不能冒充其他任务所有者。选项包括最多 512 个 UTF-16
单位的 `title`、默认开启的 `visible` 和 `cancellable`，以及可选的调用方
`AbortSignal`。回调得到关联的 `signal` 和 `report({ message?, progress? })`。
消息最多 4096 单位；进度包含有限非负数 `completed`、可选 `total`，以及可选的
`bytes`、`items` 或 `percent` 单位。上报会复制数据；取消、结束或运行代次撤销后
拒绝上报。返回的 Promise 保留工作结果或失败。

每个插件运行代次最多同时有八项未结束操作。停止、替换或撤销插件会取消任务信号。
取消是协作式的，不能强制停止任意 JavaScript 或回滚远端副作用。只有实际工作结束，
任务才会退出运行状态。隐藏任务不出现在公共列表中，但未结束时仍阻止 WebView
释放；隐藏记录结束后移除。可见历史沿用应用已有的有界历史，不代表退出应用后仍能
执行或恢复任意 JavaScript 作业。

若需提供任务界面，声明 `provider: "backgroundTasks"` 的组件视图，不填写
`location`，申请 `ui.trusted` 和 `backgroundTasks.read`，并正常注册组件。
用户在设置 → 插件 → 界面提供者中明确选择；安装不会自动接管界面。

`props.backgroundTasks.snapshot` 给出修订、`floating` 或 `embedded` 展示位置
以及各状态可见任务数量。`read({ revision, offset? })` 返回不可变的显式数据行；
每页最多 128 项，items 数组序列化后最多 65536 个 UTF-16 单位。使用 `nextOffset`
继续读取。数据包含来源、宿主分配的插件归属、状态、执行位置、有界进度和消息，
以及不带回调的动作描述。为保证转义后的 JSON 仍在分页预算内，超出预算的动作描述会被省略。key 是仅在该修订内有效的不透明标识。隐藏任务和内部字段
不会暴露。保留的读取结果不可变，后续读取仍需通过当前授权检查。

跨来源动作额外需要 `backgroundTasks.write` 和 `capabilities.actions`。
只能从当前可见帧调用 `runAction({ revision, key, actionId })`。旧帧、来源代次
替换、授权或选择撤销、禁用或不支持的动作均被拒绝；进度更新也不能绕过同一未结束
动作的并发锁。仅支持当前明确提供的动作；传输重连、冲突复核等专用控制仍由原生
任务展示提供，保留既有确认流程。

可选 `Entries` 组件最多挂载一次，组合已有的原生任务详情。省略它不会取消任务。
窗口控制、停靠、批量清空和恢复由宿主管理。恢复内置界面保留原生任务 DOM；
组件失败或重复挂载时恢复内置界面。可信前端共享 WebView 上下文，这些检查不构成
JavaScript 沙箱。

公开契约按职责位于 `src/lib/extensions/contracts/backgroundTasks/` 下的
`entry.ts`、`execution.ts`、`provider.ts`。私有运行和界面适配位于
`extensions/backgroundTasks/`；`lib/tasks/` 分开模型、注册、动作控制和执行。
兼容入口只导出已有名称。SDK 按公开文件同步并检查循环依赖和私有类型引用。
本领域仍为实验接口，不扩大稳定 RPC 承诺，也不代表已经达到 1.0 发布条件。
