# 公开偏好设置

[English](../../../en-us/development/plugins/preferences.md)

`preferences.schema`、`preferences.snapshot`、`preferences.observe`、`preferences.update` 是 API v1
的实验接口。读取需要 `settings.read`，写入需要 `settings.write`，并遵循普通插件审批和生命周期检查；不要求可信前端代码。
旧的 `settings.get/update` 保留现有兼容行为和内部字段名。

## 结构与归属

新契约分为 `general`、`appearance`、`workspace`、`terminal`、`files`、
`transfers`、`editor`、`monitoring`、`shortcuts`、`network`、`updates` 十一个领域。
通过 `preferences.schema` 发现准确的字段名、枚举和限制。快照包含 `version: 1`、
不透明的 `revision`、脱离内部状态的 `values`，以及同结构的当前平台 `defaults`。
公开领域和字段使用显式映射，内部存储不是通信契约；不要从应用内部 `Settings` 类型推导公开类型。

此接口不包含界面提供者选择、更新检查时间戳、跳过的版本、凭据和存储迁移。
网络配置包含代理身份和用户名，但不返回密码，也不授予密钥链权限。
Schema 定义结构限制，宿主还会检查代理引用、快捷键、主题标识和更新源等语义。
字符数按 Unicode 标量计数；`x-maxBytes` 额外限制 UTF-8 字节数。

## 修改快照

```ts
const before = await host.call("preferences.snapshot", {});
const after = await host.call("preferences.update", {
  revision: before.revision,
  changes: {
    appearance: { theme: "dark" },
    terminal: { copyOnSelect: true },
  },
});
```

只修改明确提供的字段。**每个字段完整替换其值**，包括嵌套映射、数组和对象。
例如 `appearance.colors: {}` 清空所有区域颜色覆盖；修改单个主机列宽时，需要从最新快照取出完整的
`workspace.hostList` 字段，修改后整体提交。未知字段、类型错误和无效值会被拒绝，不静默截断、
限幅或归一化。`preferences.invalidValue:<公开字段路径>` 指明错误字段，不回显任意值、映射键或凭据。

原生界面、旧插件接口、新接口以及更新检查元数据共用有序提交边界。
每次成功保存都在同一事务中更新设置和持久 UUID 修订，即使字段值未变也会轮换修订。
过期修订在产生副作用或持久化之前返回 `preferences.staleRevision`；应重新读取快照，
明确协调修改意图，不能直接自动覆盖新状态。把字段改走再改回，也不会恢复旧修订。
只读旧数据库不会写入修订记录，首次成功保存设置时才创建；修订在应用重启后保留。

等待其他写入之后以及持久化之前都会重新验证授权。数据库保存失败时保留设置和修订，
并恢复已预备的标题栏变化。提交后通知和外部清理在数据库事务之外执行。
这些接口不承诺回滚外部副作用，也不代表已实现插件自定义 Schema 与迁移。

## 无需设置页面的变更观察

首次调用 `preferences.observe({})` 获取快照，再将返回的不透明 `revision` 传给同一方法。
版本未变时只返回 `{version: 1, revision, changed: false}`，不包含值与默认值；
变化时返回 `changed: true` 与 `snapshot`，外层与快照中的版本一致。
读取共用设置写入的串行边界，不会拼出跨提交的值与版本。每次读取（包括等待其他写入后）
均重新验证 `settings.read` 和运行授权。输入版本限制为 1–128 UTF-8 字节，不接受控制字符、null 或未知字段。

市场 SDK 的 `sdk/preferences/client.mjs` 提供 `createPreferencesClient(host)`。
`subscribe(receive, {signal, intervalMs?})` 必须绑定所属功能的 `AbortSignal`，无需打开页面。
首次回调返回脱离内部状态、深冻结的快照，此后仅在版本变化后通知。
每个客户端最多八个订阅；间隔为 1000–60000ms，默认 2000ms，从上次读取和异步回调均完成后计算，
不会重叠请求或回调。每次读取使用 10000ms 超时；传输必须实现 `host.call` 的取消和超时选项。

`stop()` 与所属功能取消均阻止迟到回调，取消正在等待的读取或定时器。
`done` 在待决传输与回调结算后完成，不拒绝 Promise；结果原因为 `stopped`、`aborted` 或
`failed`（附 `error`）。错误会停止订阅，不自动重试。已取消但尚未结算的工作仍占配额。
回调自行创建的工作应由消费者负责取消；将所属信号绑定到视图/插件销毁，并检查 `done` 的失败结果。

这是最新状态观察：中间提交可能合并，纯元数据保存也会轮换全局版本。
它不是审计日志、持久事件游标或逐次提交交付保证。不注册服务端监听，不广播内部设置，不重试写入。
旧宿主应通过 `api.describe` 检测 `preferences.observe`；缺失时返回错误，不隐式回退到内部 `settings.get`。

## 契约维护

宿主服务位于 `services/settings/preferences/`，分别由 `contracts`、`mapping`、
`schema`、`projection`、`observation`、`update` 负责信封、映射、结构校验、读取投影、条件观察和修改适配。
各领域分别维护 JSON Schema 和映射。RPC 适配器与接口目录放在各自的
`settings/preferences` 子目录，不承担设置业务规则。

修改 Schema 后运行 `node scripts/contracts/preferences/generate.mjs`。
`--check` 校验 `src/lib/extensions/contracts/preferences/data/`（原 `src/lib/preferences/contracts/` 仅保留兼容转发） 下的独立生成类型，CI 会执行检查。
市场 SDK 同步将公开声明镜像到 `sdk/rpc/settings/preferences/`，Schema 镜像到
`sdk/preferences/schema.json`；检查模式只验证差异，不修改文件。
旧版 RPC 消费者兼容性测试独立保留，不用新增接口测试替代。

## 设置表单提供者

受信任组件视图可声明 `provider: "preferences"`，需要 `ui.trusted` 与
`settings.read`；写入额外需要 `settings.write`。用户在界面提供者中主动选择，
安装插件不会自动替换设置表单。

视图收到 `preferences`，包含不可变页面元数据（分区、查询、仅显示修改项、
公开字段标识与文案、保存状态、页面版本）、可选的 `Fields` 插槽以及经过授权的
`schema()`、`read()`、`update(request)`。页面版本仅表示界面身份，写入必须使用
`read()` 返回的持久化版本。调用复用所选插件的 RPC 会话、权限与配额。
请在挂载后的普通 effect 中读取，不要在 render 或宿主提交前的 layout effect 中调用。
属性更新后应采用新接口引用；页面或设置变化会让旧引用失效，隐藏页面不能写入。
成功写入引起自身页面更新时仍返回已提交的快照，不会自动重试写入。

`Fields` 最多挂载一次；宿主移动原有 DOM，切换提供者、恢复原生、停止、撤权或
渲染失败时保留控件草稿。也可以省略插槽。搜索、漏斗预设、导航、配置档案、
重置按钮、保存状态、提供者选择、凭据与网络表单、快捷键冲突处理、存储迁移、
日志及更新安装入口仍由宿主管理。恢复栏可随时恢复原生控件。受信任前端共享
宿主上下文，不属于沙箱。

公开数据契约归属 `contracts/preferences/data/`，表现契约归属
`contracts/preferences/provider.ts`；运行授权适配归属 `extensions/preferences/`，
与原生表单组件、私有字段映射分开。市场 UI 与 RPC 类型从同一公开源生成。
该表现接口尚不包含插件自定义设置 Schema 与迁移能力。
