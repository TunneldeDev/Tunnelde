# 插件自有存储观察

`storage.observe` 是实验接口，应通过 `api.describe` 检测支持情况。协议仍为 v1，
既有稳定 `storage.get/set/delete` 契约不变。调用需要插件当前审批和运行授权，
不额外要求领域权限。它只读取调用插件自己的 JSON KV 数据，不接受其他插件 ID、
路径、密钥选择器，也不授予宿主存储位置或迁移权限。

首次传 `{}`，条件读取传 `{revision}`。修订号是不透明标识，长度1—128个 UTF-8
字节且不能含控制字符；null、空串或额外字段返回 `plugin.api.invalid:params`。
修订号匹配时返回 `{version:1,revision,changed:false}`，省略 snapshot；
否则返回 `{version:1,revision,changed:true,snapshot:{version:1,revision,values}}`，
两个 revision 一致。缺失键和存在但值为 JSON null 的键可区分。

读取复用稳定存储的仓库锁及历史文件格式，不创建缺失文件、不改写旧数据或自动修复。
修订号绑定插件身份及递归排序后的 JSON 对象键，数组顺序有意义。这是最新状态轮询：
相同值重复写入以及两次读取之间的 A→B→A 可以合并，不是事件游标、写入计数或持久订阅。

宿主限制原始文件和编码后的 map 为256KiB，响应最多257KiB。JSON 从根 values 对象
起最大深度64，数字必须有限，整数不得超出 ±9007199254740991。顶层键只能包含
1—128个 ASCII 字母、数字、点、连字符或下划线，并排除 `__proto__`、`constructor`、
`prototype`；嵌套对象键则是普通 JSON 字符串，可以包含 Unicode 和控制字符。
字符串必须是合法 Unicode。不可观察的旧数据返回脱敏的 `plugin.api.invalidStorage`
或 `plugin.api.storageTooLarge`，不回显存储内容。这些限制属于新增观察接口，
不改变历史稳定读写契约。读取前和返回观察结果前均重新检查运行授权。

## SDK 生命周期

```js
import { createStorageClient } from "./sdk/storage/client.mjs";
const storage = createStorageClient(host);
const subscription = storage.subscribe(async (snapshot) => renderDraft(snapshot.values.draft), {
  signal: viewLifetime.signal,
});
const result = await subscription.done;
if (result.reason === "failed") reportFailure(result.error);
```

分发时包含 `sdk/storage/`、`sdk/runtime/observation/` 及引用的声明。
门面需要明确授权、支持取消及截止时间的传输，不安装运行时，也不依赖 Node 全局对象。
可信 UI 的 `api.call` 本身不提供这种传输契约。公共结果与原始数据分离并深度冻结，
嵌套的原型类键通过安全数据属性保留。

订阅必须绑定 owner AbortSignal，同一客户端最多8个。读取与异步回调串行，
1—60秒间隔（默认2秒）从上次结算后计时，单次读取截止时间10秒。
推送初始状态及变化快照。stop/abort 阻止迟到投递；closed 表示停止投递，done 等待
结算并返回 stopped/aborted/failed。取消但未结算的工作仍占额度，错误直接终止且不重试。
若传输忽略取消和截止时间，结算可能延迟；回调启动的工作需自行管理生命周期。

Rust 与 ECMAScript 对同一小数的编码可能不同，例如 `1e-6` 与 `0.000001`。
因此 SDK 另设512KiB的解码 JSON 工作预算，不用 JavaScript 重新编码长度推断原始线长；
宿主256/257KiB限制不变。CI 将真实原生产出的最大尺寸、小数及 Unicode 样例交给
结构 Schema 和实际 SDK 消费者验证。DTO 与 Schema 由独立宿主契约生成，历史 SDK
样例保持冻结。宿主存储位置、迁移及应用日志订阅需要独立契约，不由本接口提供。
