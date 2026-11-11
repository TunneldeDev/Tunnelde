# 命令历史提供者（实验性）

受信任的前端可声明 `provider: "history"` 的组件视图，需要 `ui.trusted`、
`sessions.read` 和 `history.read`。用户在“设置 → 界面提供者”中明确选择；
安装插件不会自动替换历史面板。前端运行在宿主上下文，不是沙箱，历史可能包含秘密。

```json
{
  "runtime": "frontend",
  "frontend": { "entry": "ui/index.mjs", "sdk": "^0.1.0" },
  "permissions": ["ui.trusted", "sessions.read", "history.read"],
  "views": [{ "id": "history", "title": "历史", "kind": "component", "provider": "history" }]
}
```

片段需要补齐插件标识、版本等常规字段。使用 `context.views.register("history", View)`
注册，组件收到的 `FrontendViewProps.history` 只属于当前历史面板及其连接的主机，
不能通过该上下文访问其他主机。

```js
export function activate(context) {
  const React = context.sdk.react;
  function View({ history }) {
    return React.createElement(
      "section",
      { style: { display: "flex", flexDirection: "column", flex: 1, minHeight: 0 } },
      React.createElement("span", null, history.snapshot.title),
      React.createElement(history.Entries),
    );
  }
  context.views.register("history", View);
}
```

`Entries` 可选地复用持续挂载的原生列表及用户操作按钮，最多挂载一次；恢复内置界面时
保留同一组行。也可省略并自行展示列表。搜索、数量、清空确认、加载错误、重试和恢复入口
仍由宿主保留。渲染异常、停止、撤权或受限模式会恢复内置列表；切换不会重新连接 SSH，
也不会开启自动记录历史。

`snapshot` 是独立不可变的数据结构，包含 `sessionId`、`hostId`、`title`、`revision`、
`query`、`total`、`busy` 和 `error`。`total` 是当前筛选结果数量。面板读取全部保留记录，
最多 500 条，按最近使用排序；原生 RPC 默认仍读取 200 条，未修改其传输契约。
查询、数据或加载状态变化会生成新修订并重新传入组件，无需另行管理流式订阅。

`read({ revision, offset? })` 每页最多返回 128 条、合计 65536 个 UTF-16 命令码元，
结果为 `{ revision, total, nextOffset, items }`，结束时 `nextOffset` 为 `null`。
行包含 `id`、`hostId`、`command`、`executedAt` 和 `truncated`，时间为 Unix 毫秒。
不会跨页截断命令；历史遗留的超长数据最多展示 4000 个 UTF-16 码元并标记 `truncated`，
提供者不能执行这种截断命令。正常记录本身已拒绝超过 4000 个 UTF-8 字节的命令。
必须传入对应修订，遇到 `plugin.history.changed` 时读取最新上下文重新开始。

`setQuery(query)` 使用宿主的 `@command:`、`@date:` 筛选，最多 4096 个 UTF-16 码元；
不带 `@` 的 `command:value` 是普通文本。`refresh()` 请求重新读取权威数据。
加载期间收到多次失效通知只追加一次读取，旧主机或旧面板晚到的结果被忽略。
通知是数据可能变化的提示，不是持久交付确认。

`capabilities` 声明 `delete`、`clear`、`execute`。`delete(id)` 需要 `history.write`；
`requestClear()` 需要相同权限并打开宿主确认框，确认时再次校验提供者授权及会话身份。
`execute(id)` 需要 `ssh.exec`，会立即将该条已有命令发送至当前会话，不是预览，也不返回
Shell 执行结果。自动记录仍遵循用户的“记录终端历史”设置。上述只读清单无法调用这些
修改方法；原生行上的按钮仍是用户明确发起的操作。

操作只接受当前修订中可见的条目；加载中或加载失败时禁止破坏性操作，但允许筛选和重试。
方法重新检查当前选择、运行代次、指纹、批准和权限；切换或关闭后的旧上下文失效。
异步方法通过拒绝 Promise 报错，请处理错误并显示本地化诊断。受信任代码不是沙箱，
撤权无法撤销已经发送的命令。

不需要系统 Node。该能力仍为实验性 UI SDK，不代表终端／历史领域全部稳定。
另见[历史语义](../../guide/history.md)。
