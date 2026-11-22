# 错误与诊断

错误会跨越原生 IPC、前端异步任务、渲染和展示四个边界。应用边界只归一化一次，再分发给需要的输出端；不能由展示组件决定错误是否值得记录。

## 错误契约

前端统一使用 `src/lib/api/errors.ts` 中的 `AppFailure`：

| 字段          | 含义                                                         |
| ------------- | ------------------------------------------------------------ |
| `code`        | 稳定的 IPC／应用类别，例如 `validation`、`ssh`、`internal`。 |
| `message`     | 失败层返回的原始代码或消息，不能被界面文案替换。             |
| `userMessage` | 本地化标题。未知但具体的错误键追加显示，不再被泛化提示吞掉。 |
| `severity`    | 统一推导的 `debug`、`info`、`warn` 或 `error`。              |
| `details`     | IPC 提供的结构化详情。                                       |
| `stack`       | JavaScript 错误的堆栈。                                      |

`normalizeError` 只负责分类。真实失败边界使用 `captureError`，它归一化并只写一次结构化诊断。需要默认 Toast 时使用 `notifyError`。自定义界面可以取得 `captureError().userMessage`，再通过自己的控件展示原始错误。

`translateError` 保留给旧调用点；它同样会捕获原始错误，但新增异步处理应带领域和操作调用 `captureError` 或 `notifyError`。

## 等级与输出端

- 取消属于 `debug`；校验、未找到和更新错误属于 `warn`；I/O、SSH、数据库和内部错误属于 `error`。
- 同一结构化事件可供轮转原生日志、输出面板、Toast 详情、表单内联状态和插件诊断使用。
- Toast 详情显示原始代码、消息、结构化详情和堆栈，不是另写一份错误文案。
- 全局 `error` 与 `unhandledrejection` 会被捕获，未处理的 WebView 错误不能只留在控制台。
- 日志写入是尽力而为。写入失败只在控制台报告一次，不能递归记录。
- 前端不会把疑似凭据的详情值或字段名复制到日志字段；原生日志还会对敏感键脱敏。

## 原生错误

`AppError` 在序列化时保持稳定 IPC 负载，并在传输边界记录原始类别与消息。原生代码应返回稳定键，而不是面向用户的整句文案。前端可以同时显示通用类别和具体键，但具体键不能被静默丢弃。

每个操作应带稳定的领域和操作名，例如 `hosts/saveEditor`、`panels.windows/drag` 或 `plugins/install`。除非明确属于尽力而为的清理路径，`catch` 不能静默返回。
