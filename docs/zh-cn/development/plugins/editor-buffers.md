# 已加载编辑器缓冲区数据

[English](../../../en-us/development/plugins/editor-buffers.md) · [编辑器命令](editor-plugins.md)

这些实验接口补充稳定的 `editor.active`/`editor.replace`，通过 `api.describe`
发现支持情况。每次调用都需要已批准、仍有效的插件运行实例和对应权限。仅操作
已加载且就绪的缓冲区，不打开文件、不保存磁盘、不重新连接，也不申请新授权。

| 方法                | 权限           | 请求                                           |
| ------------------- | -------------- | ---------------------------------------------- |
| `editor.observe`    | `editor.read`  | `{tabId?, revision?}`                          |
| `editor.readRange`  | `editor.read`  | `{tabId, documentId, version, offset, limit?}` |
| `editor.applyEdits` | `editor.write` | `{tabId, documentId, version, edits}`          |

独立公共 DTO 位于 `contracts/editor/data/`，不依赖内部状态并镜像到市场 SDK。
响应 `schemaVersion: 1` 是结构版本，缓冲区 `version` 是内容版本。
新接口拒绝未知字段、null 和无效值。

## 观察和生命周期

`observe({})` 捕获当前活动标签的就绪缓冲区，无可用编辑器时返回 null。指定
`tabId` 后独立观察该缓冲区，不随活动标签切换。元数据仅包含 `tabId`、
`documentId`、`version`、`path`、`name`、`utf16Length`、`dirty`，不包含内容、
基线、会话或内部错误。

首次/变化后返回 `{schemaVersion: 1, revision, changed: true, snapshot}`。
传回同一不透明 revision，未变化时仅返回 `{schemaVersion: 1, revision,
changed: false}`。token 为 1–128 UTF-8 字节，不含控制字符。revision 绑定
选择器和捕获的元数据，包括保存后仅 dirty 变化的情况，不对内容哈希、不永久缓存。
捕获早于异步哈希，响应到达时可能已有更新；后续读写必须使用快照中的精确身份和版本。

这是最新状态观察，允许中间变化合并，不是编辑事件日志。关闭再打开或替换缓冲区
会改变 `documentId`。正在加载、出错和断开的缓冲区不可用。选中文件不代表
文件已加载，接口不会替插件加载文件。

## 分段读取和原子编辑

偏移量和半开范围以 UTF-16 代码单元计数。读取上限范围 2–16384，默认 16384。
起点不能切开代理对，页末必要时缩短到 Unicode 标量边界。返回身份/版本、
`offset`、`totalLength`、`text`、`nextOffset`（到末尾为 null）。末尾读取返回
空文本，分页包含未保存内容。过期版本报错，应从新元数据重新分页，不能混用版本。

每项编辑为原始缓冲区上的 `{start, end, text}`。最多 128 项，起点升序、
不重叠、起点不重复、范围不切开代理对。替换文本为良构 Unicode，合计最多
64 KiB UTF-8；最终缓冲区最多 2 MiB UTF-8，与原生保存限制一致。先验证整个
批次，再进行一次身份/版本比较和修改，一次撤销恢复整个批次。空批次或文本未变化
时不修改版本/历史；变化时版本只增加一次，安全整数版本耗尽时先报错再修改。
返回 `{schemaVersion: 1, tabId, documentId, version, dirty, utf16Length}`，
不自动保存或重试。

`editor.documentChanged` 要求重读并判断编辑是否仍适用。校验错误以 `invalid:`
开头，大小/版本错误为 `editor.editTooLarge`、`editor.documentTooLarge`、
`editor.versionExhausted`。已有缓冲区包含非法 Unicode 时返回
`editor.invalidUnicode`，可通过明确的编辑修复。既有前端 RPC 传输会包装为 `plugin.api.frontend:<key>`。
既有权限、运行实例和取消错误仍适用。修改启动后发生
超时或错误不代表已回滚，应先观察/重读再决定后续操作。

## SDK 生命周期

`sdk/editor/client.mjs` 的 `createEditorBufferClient(host)` 提供 `observe`、
`readRange`、`applyEdits`、`subscribe`。每次调用支持传输选项
`{signal?, timeoutMs?}`。分发时同时包含 `sdk/editor/`、
`sdk/runtime/observation/` 和引用声明，没有运行时依赖或 Node 全局变量。
需要显式提供支持取消/超时的已授权传输，可信 UI 基础
`api.call(method, params)` 本身不具备该契约；封装不安装或选择运行环境。

`subscribe(receive, {signal, intervalMs?, tabId?})` 必须绑定 owner AbortSignal，
可选 tabId 在订阅期间固定。首次投递冻结元数据或 null，之后只投递变化。
间隔 1000–60000 ms，默认 2000，在上次读取和异步回调结束后计时；读取超时
10000 ms。每客户端最多八订阅，同一订阅读取/回调不重叠。取消后未结算工作仍占
额度。`stop()`/abort 阻止迟到回调，`closed` 表示停止投递，`done` 等待结算，
解析为 stopped/aborted/failed，不 reject。出错停止，不自动重试。绑定功能/
视图/插件销毁，并检查 done；忽略取消/超时的自定义传输可延迟结算，回调自行
启动的工作需要自己绑定取消。

稳定整篇接口保留 128 KiB 限制和既有行为。本次不改变格式化命令、不统一文件/
预览生命周期、不承诺持久流，也不扩大稳定 API 范围。
