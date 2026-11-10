# 公开偏好设置

[English](plugin-preferences.en-us.md)

`preferences.schema`、`preferences.snapshot`、`preferences.update` 是 API v1
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
这些接口不承诺回滚外部副作用，也不代表已实现插件自定义 Schema、迁移或可替换的设置界面。

## 契约维护

宿主服务位于 `services/settings/preferences/`，分别由 `contracts`、`mapping`、
`schema`、`projection`、`update` 负责信封、映射、结构校验、读取投影和修改适配。
各领域分别维护 JSON Schema 和映射。RPC 适配器与接口目录放在各自的
`settings/preferences` 子目录，不承担设置业务规则。

修改 Schema 后运行 `node scripts/contracts/preferences/generate.mjs`。
`--check` 校验 `src/lib/preferences/contracts/` 下的独立生成类型，CI 会执行检查。
市场 SDK 同步将公开声明镜像到 `sdk/rpc/settings/preferences/`，Schema 镜像到
`sdk/preferences/schema.json`；检查模式只验证差异，不修改文件。
旧版 RPC 消费者兼容性测试独立保留，不用新增接口测试替代。
