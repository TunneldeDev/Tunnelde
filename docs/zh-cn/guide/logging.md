# 本地日志与诊断

Tunnelde 将应用诊断日志写入配置的“日志”存储目录，按天轮转，文件名为
`YYYY-MM-DD.tunnelde.jsonl.log`。输出面板读取这些文件，显示带颜色的可读日志；磁盘上保留
JSON Lines 格式，方便工具分析。通过底栏“输出”或命令面板打开可停靠的下面板，在其操作菜单中
打开原始日志或日志目录。清空面板显示不会删除本地日志文件。

诊断日志记录级别、领域和技术上下文；操作历史记录有数量上限的操作及不透明对象 ID。
两者都不应包含密码、密钥、认证头、文档正文或终端输入。

`log.file` 中的构建机路径表示构建应用时所用依赖的源码位置，不表示用户电脑必须有这个目录。
保留这些源码位置有助于定位问题；排查实际故障时应打开本地应用日志。

## 内置功能

原生模块可调用 `crate::diagnostics::write(LogOrigin::Native, LogEntry { ... })`。
已有 `tracing` 事件继续使用同一本地写入器。前端从 `src/lib/diagnostics.ts` 导入
`writeLog(domain, entry)`，或在失败路径使用尽力记录的 `reportError(domain, operation, error)`。
原生 `logs_write` 命令会为前端领域添加 `frontend.` 前缀。事件总线已接入此路径，
订阅者失败会进入本地日志，不再只出现在开发者工具中。

```ts
await writeLog("files", {
  level: "warn",
  message: "Listing did not complete",
  operation: "list",
  requestId: "request-123",
  fields: { attempt: 2, status: 403 },
});
```

## 插件 API

经过批准、正在运行且拥有 `log` 权限的插件可调用现有 `log` 宿主方法。
SDK 保留 `host.log(message, level)`，并增加选项对象重载：

```js
await host.log("Connection failed", {
  level: "error",
  domain: "connection",
  operation: "connect",
  requestId: "request-123",
  fields: { status: 403, attempt: 2 },
});
```

`log` 方法具有[冻结的 v1 契约](../../../tests/fixtures/plugin-compat/logging-v1.json)，
可通过 `host.describe()` 发现。message/level 调用自 0.21.0 起提供；结构化选项及按指定级别
写入的行为需要 0.33.0-beta.5 或更新宿主。旧宿主可能忽略新增选项；依赖这些语义前应检查
契约，或设置相应的 `engines.tunnelde` 版本范围。`since` 表示方法首次可用版本，
不表示所有选项或稳定承诺的引入时间。级别包括 `trace`、`debug`、`info`（默认）、
`warn`、`error`，同时接受对应大写和 `warning`。无效级别会被拒绝。
指定级别就是事件实际写入和原生过滤使用的级别。WASM 现有数字日志 ABI 保持不变。

插件 ID 和运行代次由宿主提供。领域为 `plugins.<插件 ID>.<domain>`，默认领域后缀为
`application`，因此参数不能冒充其他插件。审批、权限和运行代次撤销检查继续生效。
该接口不允许插件指定日志文件路径，也不提供任意读取应用日志的能力。

message 的 UTF-8 长度最多 16 KiB。domain、operation、requestId 为可选的非空 ASCII 标识符，
最多 128 字节，仅允许字母、数字、`.`、`_`、`-`、`:`。fields 是 JSON 对象，脱敏前最多 16 KiB、
最多访问 256 个节点（包括根节点）、根节点下最多四层嵌套；包括嵌套对象在内的键使用
同样的字符范围，最多 64 字节。domain、operation、requestId 也接受 null，表示未提供；
message、level、fields 不接受 null。未知的顶层字段会被忽略。结构描述检查类型与字符数，
UTF-8 字节配额、嵌套键、深度和节点数由运行时另外校验。
控制字符被替换为空格。系统递归隐藏类似凭据的字段值，并移除结构化 HTTP/SOCKS URL 字符串的
用户信息、查询串和片段。任意文本和 URL 路径中的秘密无法可靠识别，调用方必须避免写入。
上下文字段保留在嵌套区域，不能覆盖宿主级别、身份或分类。

输出面板支持 `@domain:`、`@plugin:`、`@level:`、`@source:` 筛选和漏斗预设。
操作及请求 ID 也可以在消息中搜索。写入返回 null 表示宿主已接受事件，
仍受 `TUNNELDE_LOG` 过滤影响，默认值为 `info,tunnelde_lib=debug`。
有界非阻塞写入器在过载时可能丢弃日志；这是诊断记录接口，不能用作持久审计事务，
也不保证返回成功时事件已经同步到磁盘。
该方法不为调用方订阅事件，也不将本地 JSONL 记录布局承诺为稳定协议。格式错误返回
`plugin.api.invalid:log`；字节、标识符或上下文限制返回 `logs.invalid:<字段>`，
两者的 JSON-RPC 代码均为 `-32000`。公共参数对象或总请求大小校验使用 `-32602`，
授权错误使用 `-32001`。除契约列出的 `knownErrors` 外，调用方也必须处理未知错误。
