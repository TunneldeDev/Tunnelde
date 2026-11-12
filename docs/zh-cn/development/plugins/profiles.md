# Profile 元数据观察

`profiles.observe` 为实验接口，需要 `settings.read`、调用插件当前的批准及运行代次
授权。通过 `api.describe` 探测支持情况，旧宿主可能没有此方法；协议版本仍为 1。

首次使用 `{}`，条件读取使用 `{revision}`。修订号是不透明令牌，长度为 1–128 个
UTF-8 字节，不含控制字符；明确的 null、空令牌或额外请求字段均被拒绝。结果为：

```json
{ "version": 1, "revision": "opaque", "changed": false }
```

或 `changed:true`，并携带 `snapshot:{version:1,revision,items}`。两处修订号一致。
列表保持原生顺序，每项只有 `id`、`name`、`updatedAt`（Unix 毫秒）。最多 32 项，
编码后的响应不超过 32 KiB。ID 非空、最多 128 个 UTF-8 字节且无控制字符；名称
遵循原生的去首尾空白、大小写不敏感唯一、最多 64 字符规则。时间戳为非负安全整数。
不返回保存的设置、代理密码、提供者选择、存储路径、数据库键或激活配置的权限。

读取使用一致的 SQLite 事务。原生保存/删除将列表与新 UUID 代次一起提交；失败
则同时保留旧数据及旧版本。数据库重开后版本不变。旧数据库观察不会写入新令牌。
另外使用公开元数据摘要，识别不更新代次的历史写入者造成的列表变化；私有设置内容
不进入摘要。当前原生保存即使没有改变可见元数据，也可能使修订号失效。本接口
观察最新状态，不是事件游标，也不承诺逐次提交投递。

投影前限制存储输入及元数据解码。损坏、重复、超限或非法元数据返回
`profiles.invalidStorage`，不回显原值，不静默修复或覆盖。原生保存超限返回
`profiles.storageTooLarge` 并保留旧数据。数据库操作前及结果编码前均检查授权。

## SDK 生命周期

```js
import { createProfilesClient } from "./sdk/profiles/client.mjs";

const profiles = createProfilesClient(host);
const subscription = profiles.subscribe(
  async (snapshot) => {
    updateProfileNames(snapshot.items);
  },
  { signal: viewLifetime.signal },
);

const result = await subscription.done;
if (result.reason === "failed") reportFailure(result.error);
```

严格客户端提供 `observe(request?, {signal?,timeoutMs?})` 和 `subscribe`。随插件分发
`sdk/profiles/`、`sdk/preferences/schema.mjs`、`sdk/runtime/observation/` 及引用声明，不需要 Node 全局变量或安装
运行时。应使用明确授权且支持取消/期限的传输。当前可信 UI 的 `api.call` 在透传
第三个 options 参数时支持这些语义；自定义或历史传输需要提供等价实现。

订阅必须绑定所属方的 AbortSignal，每客户端最多八个，读取及回调串行执行。
每次读取和异步回调结束后等待 1000–60000 ms，默认 2000 ms；读取期限 10000 ms。
首次投递元数据，此后只投递修订变化。结果为脱离原数据的深度冻结对象。停止或
取消阻止迟到投递；`closed` 表示已停止投递，`done` 等待结算后解析为
stopped/aborted/failed。取消后尚未结算的工作仍占额度；错误停止，不自动重试。
忽略取消/期限的传输可能延迟结算，回调自行启动的任务也需绑定生命周期。

DTO 位于 `contracts/profiles/data/`，自动镜像到 SDK 的 RPC/UI 模块；机器 Schema
镜像到 `sdk/profiles/schema.json`。结构校验之外，宿主/消费者还检查 UTF-8 字节数、
ID/名称唯一性、首尾空白、修订号配对及输出大小。CI 使用真实 Rust 输出验证 Schema
及指定 SDK 消费者，并检查目录/类型一致性与历史消费者。

[公共正文读取](profile-content.md) 使用独立正文修订号及 SDK read 方法。
[草稿写入与确认启用](profile-mutations.md) 需要单独写权限。文件导入导出和持久订阅
仍是独立契约；已有原生控件及稳定设置/编辑器 API 保持兼容。
