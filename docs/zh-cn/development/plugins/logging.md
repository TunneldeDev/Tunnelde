# 持久化日志读取

`logs.read` 为实验接口，与稳定的 `log` 写入接口分离，使用前通过 `api.describe` 检查支持。
已批准运行的插件需要独立的 `logs.read` 权限。该授权覆盖应用诊断、操作历史及其他插件的日志，
任意消息可能包含敏感信息。只有写日志权限不会获得读取能力；运行代次撤销与受限模式继续生效。

```js
import { createLoggingClient } from "./sdk/logging/client.mjs";

const logs = createLoggingClient(host);
const owner = new AbortController();
const subscription = logs.subscribe(
  async (page) => {
    if (page.gap) showIncompleteHistory();
    await appendEntries(page.entries);
  },
  { signal: owner.signal, intervalMs: 2000 },
  { source: "diagnostics", filter: { levels: ["warn", "error"] } },
);
// 随所属视图或运行代次释放；done 在未结束工作实际结算后返回。
owner.abort();
await subscription.done;
```

可信前端插件可用 `{ call: (...args) => context.api.call(...args) }` 适配 host。
此 SDK 不给前端运行时引入 Node 依赖。

## 查询与投影

source 为 diagnostics（默认）或 operations；limit 为 1–200，默认 100。
filter.domains、filter.plugins、filter.levels 精确匹配，同字段多个值取或，不同字段取且，
省略或空数组表示不限。领域标识允许 ASCII 字母、数字、`.`、`_`、`-`、`:`，1–256 字节、
最多 16 个；插件标识使用相同字符集，1–128 字节、最多 16 个。级别为小写 trace、debug、
info、warn、error，最多五个；重复值无效。text 为对投影后的消息、领域、插件及字段进行的
不区分大小写的纯文本检索，最多 256 个 UTF-8 字节，不允许控制字符。null 选择器及未知字段无效。

独立 DTO 包含 timestamp、level、domain、pluginId、message、fields、truncated。
缺失或无效时间戳为 null。结构化字段复用写入器的凭据键及 HTTP/SOCKS URL 脱敏规则，任意消息和
URL 路径中的秘密无法可靠清除。消息最多 16 KiB，编码后每项最多 64 KiB、每页最多 128 KiB。
坏行及过长记录跳过并设置 gap；投影文本或字段裁剪设置 truncated。不返回原始 JSONL 行、
所选日志文件名、游标路径、终端字节或内部状态结构；消息及上下文仍可能包含路径等敏感元数据。
操作历史投影固定动作与不透明对象 ID；只有记录插件目标的
动作才提供插件身份，其余为 null。

## 游标与生命周期

返回 `{version:1,source,entries,cursor,hasMore,reset,gap}`；后续读取使用相同 source/filter
传回 cursor。游标是有界位置记录，绑定进程、插件指纹、运行代次和规范化查询。切换筛选、来源、
所属插件或重启进程后应重新读取。游标不选择路径也不授予能力，即使修改位置也不能绕过读取权限。
文件句柄拒绝所选文件的符号链接、reparse point 和非常规文件。

诊断初始读取只考虑宿主选定的当前轮转文件，从最近 256 KiB 内开始；更早字节会报告 gap。
后续每次最多扫描 256 KiB／2048 条，保留第一页未能容纳的匹配项。未完成尾行等追加，过长行分段
丢弃。文件身份及位置前 64 字节用于检测普通替换和截断，这只是追加日志的尽力检测，不是文件快照，
不能证明任意原地改写未发生。轮转、当前文件消失、位置失效会设置 reset 和 gap；不会补读旧文件。
操作来源按 ID 读取最近保留的 1000 条，保留缺口或位置失效也会报告。不承诺可靠投递或完整历史审计，
现有非阻塞写入器也可能丢弃记录。

hasMore 应串行排空。SDK 页间让出执行权，等待回调完成，每连续 32 页后等待轮询周期；每次调用
截止时间 10 秒。每个客户端最多八个订阅，必须绑定 owner AbortSignal，轮询间隔为 1–60 秒整数。
取消后不交付迟到回包，未结束请求和回调实际结束前仍占名额。stop／abort 通过 done 返回；传输、
校验或回调失败会以 `{reason:"failed",error}` 终止，不会丢失游标后静默重试。原生还有独立的
四个阻塞工作名额，取消等待方不会提前释放；I/O 前后在策略／数据库锁之外检查授权，竞争时可能返回
plugin.api.busy。

公开错误包括 logs.read.invalidRequest、logs.read.invalidCursor、logs.read.unavailable、
共用授权／取消错误及 plugin.api.busy。unavailable 不暴露文件系统或数据库细节；其他诊断可在
应用本地日志查看。调用方仍应处理未知错误并发现实验能力。

机器结构描述位于 src-tauri/src/plugins/api/domains/logging/schema.json，独立 TypeScript DTO
位于 src/lib/extensions/contracts/logging/。SDK 同步检查两者，CI 读取真实 Rust 读取器输出进行
互操作验证。原生输出面板 IPC 与冻结的稳定写入契约继续独立。参见[日志使用说明](../../guide/logging.md)。
