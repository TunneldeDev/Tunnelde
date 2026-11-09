# 插件主机字段

插件可以通过 Manifest 的 `hostFields` 声明可选、非敏感的主机元数据。Tunnelde 在主机详情中按已安装插件分组折叠，展开后才加载字段值。编辑字段不会启动插件、执行插件代码、授予权限或使用 Node。

```json
{
  "permissions": ["hosts.read", "hosts.write"],
  "hostFields": {
    "version": 1,
    "fields": [
      { "id": "owner", "label": "负责人", "type": "text", "maxLength": 120 },
      { "id": "managed", "label": "已纳管", "type": "boolean" },
      {
        "id": "tier",
        "label": "环境",
        "type": "select",
        "options": [
          { "value": "production", "label": "生产环境" },
          { "value": "test", "label": "测试环境" }
        ]
      }
    ]
  }
}
```

字段结构仍属实验接口，其版本独立于 `apiVersion`。支持 `text`、`number`、`boolean`、`select`，可选 `description`。文本的 `maxLength` 为 1–4096 个 Unicode 码点，默认 4096；数字支持有限的 `minimum`、`maximum`；选择字段包含 1–64 个值唯一的选项。每个插件可声明 1–32 个不重复字段，ID 为 1–64 个 ASCII 字母、数字、点、下划线或连字符。标签最多 120 码点，说明最多 512 码点，均为纯文本。未知属性、标签中的控制字符和不适用的类型约束会被拒绝。字段均可不设置：省略键表示取消设置。空文本、`false`、`0` 与未设置不同。`null`、未声明的键和类型错误的值会被拒绝。密码、密钥等应使用 secrets API，不应存入主机字段。

扩展目录通过 `hosts.fields` 描述此能力。`hosts.getFields({hostId})` 要求声明并获准 `hosts.read`，返回 `{schema, document}`。文档包含 `hostId`、`revision`、`schemaDigest`、`schemaVersion`、`storedSchemaVersion`、`schemaChanged`、`values`。新文档的修订号为 0，保存结构版本为空。数据命名空间由已授权的插件身份和主机 ID 确定，调用者不能指定其他插件 ID。

`hosts.setFields({hostId, expectedRevision, schemaDigest, values})` 还要求 `hosts.write`，替换整个字段值映射并返回同形快照。当前结构摘要和文档修订号必须同时匹配；清空全部值也会递增修订号。`hostFields.conflict`、`hostFields.schemaChanged` 不修改已存数据。应重新读取并协调草稿，不应直接重复覆盖。同步提交与插件撤权串行处理。新增方法仍属实验接口，已有稳定核心契约保持兼容。

字段结构变化不会自动删除或解释旧值，读取时会保留旧值并设置 `schemaChanged: true`。插件可使用当前结构和修订号明确迁移。宿主表单展示原始值，并在准备仅保留兼容字段的草稿前询问用户；只有保存成功才修改数据。保存失败保留草稿，重新加载前会确认是否放弃未保存修改。

单个值映射的序列化 UTF-8 JSON 上限为 32 KiB，每插件总计 4 MiB，全局 32 MiB。保留的文档数量每插件最多 2048，全局最多 16384，空文档也计数。数据随应用数据库参与正常迁移与备份。停止、撤权或卸载插件会保留字段，重新安装相同 ID 并经过正常授权后可恢复访问。删除主机会级联删除其字段文档。卸载不会释放此配额；可在卸载前替换为空映射清除值，或删除主机以移除文档。因此插件 ID 是持久命名空间，不能把它理解为阻止用户新批准的同 ID 替代包访问旧值的秘密隔离机制。

成功写入后，宿主发出仅含 `{pluginId, hostId, revision}` 的原生 `hosts://fields-changed` 提示事件，并记录不包含字段值的操作审计。事件可能丢失，修订号才是权威依据。宿主表单在无编辑时刷新，正在编辑时保留草稿。此原生通知不等同于新增插件订阅接口。表格列见[主机列扩展](plugin-host-columns.zh-cn.md)，主机来源和连接所有权属于其他扩展能力。

参见[界面提供者](plugin-ui-providers.zh-cn.md)和[插件开发](plugins.zh-cn.md)。
