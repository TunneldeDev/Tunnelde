# 插件事件

[English](plugin-events.en-us.md) · [API 兼容性](plugin-api.zh-cn.md)

`events.publish` 将插件的数据通知发送到应用前端，具有冻结的 v1 契约。不需要额外的
领域权限，但调用者必须是已批准、正在运行的可执行插件；受限模式、撤销授权和旧运行
代次仍会阻止调用。事件不会授予文件、命令或其他 API 的权限。

```js
await host.call("events.publish", {
  event: "progress",
  payload: { operationId: "export-1", completed: 3, total: 10 },
});
```

事件名长度为 1–128 个 ASCII 字符，只接受字母、数字、`.`、`_`、`:`、`-`。
`payload` 可以是任何 JSON 值，省略时默认为 `null`，兼容原有调用。额外参数被忽略。
完整参数对象按序列化后的 UTF-8 限制为 256 KiB，包括事件名和 JSON 开销。

宿主统一在 `plugin://event` 发出以下封装：

```json
{
  "pluginId": "example-plugin",
  "generation": 7,
  "event": "progress",
  "payload": { "completed": 3 }
}
```

`pluginId` 和 `generation` 由宿主的已批准运行环境提供，插件参数无法替换它们。
后台进程任务也使用这一封装，但其 `task` 负载仍属于实验接口；稳定的外层结构不代表
每个插件的负载、聊天协议或任务 API 都已稳定。消费者应忽略不认识的新增字段。

返回 `null` 表示事件传输层接受了发布，不代表订阅者已处理、保存或显示。没有订阅者时
也可以成功。事件没有持久化、历史回放、跨请求完成顺序或恰好一次投递保证。需要恢复的
操作应保留自身状态并提供快照／查询接口，不能只依赖事件。

消费者必须在应用更新前校验插件身份和当前运行代次。停止、重启或撤销时，已经进入前端
队列的旧事件仍可能到达；它们必须被忽略。聊天等领域还应校验会话、运行 ID 和序号。
统一的前端事件总线共用传输监听器，在最后一个订阅结束时解除监听，不保留事件负载，
支持 AbortSignal，并隔离每个处理器的错误。

非法事件名报告 `plugin.api.invalidEvent`；字段缺失或类型错误分别报告
`plugin.api.missing:event` 和 `plugin.api.invalid:event`；非对象或超过字节配额的参数报告
`plugin.api.invalidParams`。传输失败会返回错误，不能当成发布成功。错误格式沿用
[API 兼容性说明](plugin-api.zh-cn.md)。不要在事件中发送密码、令牌或私钥。

`api.describe` 提供 `inputSchema`、`resultSchema`、`errorSchema` 和 `eventSchema`。
CI 校验实际宿主生成的事件和返回值，并使用冻结的旧 SDK 回放请求／响应。API 协议版本
仍为 1；此契约不改变其他实验接口的稳定性。
