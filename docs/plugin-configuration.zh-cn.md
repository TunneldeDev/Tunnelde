# 插件配置

Manifest 的可选 `configuration` 扩展点用于声明插件自有设置。用户可在**设置 → 插件 → 插件配置**中编辑，无需启动或批准插件代码。插件分组默认收起，展开后才读取配置。设置搜索支持 `@plugin:标识`、`@group:general`、`@id:字段`，漏斗菜单提供预设。更改需点击**保存**；修订冲突会保留草稿，要求检查，不会自动重试覆盖。

配置按插件标识保存在可迁移的**插件数据**类别中，作用于整个应用；卸载插件会保留数据。应用偏好的 Profile 与稳定的 `storage.*` 键值 API 保持原有行为。凭据应通过 `secrets.*` 保存，不应放入配置默认值或普通配置。

## Manifest 与 Schema

```json
{
  "configuration": {
    "version": 1,
    "groups": [{ "id": "general", "title": "常规" }],
    "fields": [
      { "id": "enabled", "group": "general", "title": "启用", "schema": { "type": "boolean" }, "default": false },
      { "id": "limit", "group": "general", "title": "结果上限", "schema": { "type": "integer", "minimum": 1, "maximum": 100 }, "default": 20 }
    ]
  }
}
```

这是一个封闭的 JSON Schema 子集，未知关键字会被拒绝，支持以下结构：

| 类型 | 必需关键字 | 可选关键字 |
| --- | --- | --- |
| `boolean` | `type` | — |
| `string` | `type`、`maxLength` | `minLength`、字符串 `enum` |
| `number`、`integer` | `type`、`minimum`、`maximum` | — |
| `array` | `type`、`items`、`maxItems` | — |
| `object` | `type`、`properties`、`required`、`additionalProperties: false` | — |

不支持引用、外部 Schema、可执行校验器或类型强转。字符串长度按 Unicode 码点计算，整数及整数范围必须处于 JavaScript 安全整数范围。每个顶层字段必须声明有效默认值，保存时必须提供全部字段，不得包含未知字段；嵌套对象可声明可选属性。标量使用原生控件，数组和对象使用经过校验的 JSON 编辑框，元数据仅作为纯文本显示。

上限为 16 个分组、64 个字段、64 KiB 声明、64 KiB 配置、嵌套深度 8、512 个 Schema 节点；字符串最多 16,384 码点，数组最多 256 项，枚举最多 128 个选择。数据库最多保存 4,096 个插件文档，含备份的序列化值总计不超过 64 MiB。备份已满时必须由用户或所属插件明确删除不再需要的备份，之后才能迁移或恢复。

## 自有 API 与并发

所有 `configuration.*` 方法均为**实验接口**，可通过 `api.describe` 与 `plugin.configuration` 扩展点发现。调用需要当前代次的已批准插件运行环境，不要求全局设置权限。身份由运行环境提供，方法不接受目标插件标识。原生设置表单读取已安装的惯性元数据，编辑不授予执行权限。

| 方法 | 请求 | 返回 |
| --- | --- | --- |
| `configuration.schema` | `{}` | Manifest 配置声明 |
| `configuration.snapshot` | `{}` | 声明、摘要、状态、值及修订 |
| `configuration.update` | `{expectedRevision, schemaDigest, values}` | 新快照 |
| `configuration.migrate` | `{expectedRevision, schemaDigest}` | 迁移后快照 |
| `configuration.backups` | `{}` | 最多 8 份自有备份，包含值 |
| `configuration.restore` | `{expectedRevision, schemaDigest, backupId}` | 恢复后快照 |
| `configuration.deleteBackup` | `{expectedRevision, schemaDigest, backupId}` | `null` |

读取不会将默认值写入磁盘，也不会迁移配置。第一次保存前修订为 `initial`；每次成功替换、迁移和恢复都会生成新 UUID。修改请求必须同时带修订和当前 Schema 摘要；即使值变回原样，旧修订也不会再次有效。存储的 Schema 不匹配时会阻止普通保存，即使新值本身能通过校验。

SDK 的独立 `sdk/configuration/client.mjs` 门面提供严格方法签名，不经过旧版 `host.call` 的动态回退重载；在旧宿主上使用前应检查接口发现。已有调用与协议 `apiVersion: 1` 保持兼容。值错误返回 `configuration.invalidValue:<字段路径>`，过期修订返回 `configuration.conflict`；Schema 漂移、缺少迁移、迁移操作冲突、备份容量均有独立本地化错误。IO 和数据库失败保留原错误类别。

## 明确升级与恢复

`snapshot.status` 分为 `ready`、`migrationRequired`、`incompatible`。需要迁移时仍返回已存储的原值及版本。降级、在同版本修改数据结构均不兼容；修改标签、分组或字段顺序不改变数据摘要。

最多声明 32 个迁移步骤，每步包含 `fromVersion`、精确 `fromDigest`、严格递增的 `toVersion`、精确 `toDigest`，以及最多 128 个操作。源和目标的数据摘要可从对应声明的快照获得，摘要不包含标签、分组、顺序或迁移历史。支持顶层 `rename {from,to}`、`setDefault {key,value}`、`remove {key}`：重命名拒绝缺失源或已存在目标，补默认值不会覆盖已有值，删除拒绝不存在的字段。步骤必须组成精确的版本与摘要链，最终完整配置必须满足目标 Schema。

只有原生表单确认或所属插件明确调用 API 才迁移。旧文档备份与新文档在同一 SQLite 事务提交，失败全部回滚；迁移不运行插件代码、命令或插件 SQL。恢复会先保存当前文档，再生成新修订；恢复到旧 Schema 后可能还需迁移。备份不会被静默淘汰，删除前可在设置折叠区查看备份值。配置值不会写入日志或失效广播。

## 实现边界

原生实现位于 `services/plugin_configuration/`，公开 `contracts/`、Schema 定义与值校验、事务存储、数据迁移各自独立；传输适配位于 `plugins/configuration/`。前端契约位于 `lib/extensions/contracts/configuration/`，表单组件、草稿运行逻辑、搜索与值处理分别位于 `features/plugins/configuration/` 子目录。Hub 将公开契约镜像到领域 SDK 目录，并与选定宿主检查一致性。这些新增能力不代表整个插件架构或实验接口已经稳定。
