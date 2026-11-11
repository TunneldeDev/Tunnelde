# 公共 Profile 写入与启用

本组实验接口需要 `settings.read`、`settings.write`、当前批准和有效运行代次，
并通过 `api.describe` 探测支持；不会扩大 AI/MCP 工具白名单。原生控件、元数据
观察与正文读取保留契约。独立 DTO 位于 `contracts/profiles/data/mutations`，
机器 Schema 自动镜像到 SDK。

## 保存、改名和删除

`profiles.drafts.prepare({revision,totalBytes})` 按目录的 `pc1` 正文版本预留内存
上传，`totalBytes` 为 1–16515072 个 UTF-8 字节。使用
`profiles.drafts.append({draftId,offset,text})` 顺序追加非空分段，每段最多
32768 字节，`offset` 必须等于上次确认的字节数。两者返回
`{version:1,draftId,totalBytes,offset}`。重复或乱序分段会被拒绝且不修改正文，
不隐式重试。

`profiles.save({revision,draftId,name,id?})` 省略 `id` 时创建，提供现存 ID 时
替换；不接受 null。名称去掉首尾空白后必须为 1–64 个 Unicode 字符、不含控制
字符，且大小写不敏感唯一。正文必须包含完整的 11 个公共 `PreferenceValues`
分组及全部必需字段。拒绝未知字段、非法值、被禁止的 CSS URL/import 和静默
规范化。沿用最多 32 份配置与历史集合大小限制；局部偏好更新仍有单独的 256 KiB
请求限制，不将它强加给分段配置正文。

创建时，未公开的私有字段采用原生默认值；替换时保留该已保存配置的私有界面
提供者选择。这些操作不会应用配置或修改当前设置。非法旧正文直接拒绝而不修复，
仍可通过元数据接口改名或删除。

`profiles.rename({id,name,revision})` 保留正文和选择。
`profiles.delete({id,revision})` 仅在删除当前选中项时清除选择，保留已应用设置。
三者返回 `{version:1,id,revision}`，包含新的正文版本并发布原生配置变更事件。
元数据 `profiles.observe` 继续使用独立修订号。

解码、校验、哈希和集合序列化均在数据库锁外执行。最终事务在有效授权和一次性
取消围栏下比较捕获的原始正文与 nonce，包括行是否存在，再一起提交正文、nonce
和选择清理。并发原生保存或旧写入者的正文变化会返回 `profiles.conflict`，需要
刷新并审查后重新发起。仅选择项变化不改变正文版本；保留的配置会保留最新选择。

## 运行归属和取消

草稿归属于插件 ID、安装指纹和运行代次，知道草稿 ID 并不代表有权使用。全局最多
四份、每运行代次两份，合计最多预留 32 MiB。空闲期限 120 秒，绝对期限 600 秒；
后续注册表操作或运行退出时回收过期项。不在磁盘生成临时文件。旧代次清理不会
删除新代次上传。

`profiles.drafts.discard({draftId})` 对已丢弃、不存在、过期或其他所属方的草稿
统一返回 `{version:1}`，不泄露其他运行状态；已被工作者领取的草稿返回
`profiles.draft.busy`。领取后只能使用一次，即使校验失败也会消耗；实际工作者
退出之前持续占用预留额度。

最多四个写操作工作者，取消后未结算也占额度。取消在最终提交边界之前生效则阻止
发布；提交开始后取消可能丢失响应，但提交仍可成功。撤权与发布共用策略围栏。
保存、改名、删除或启用结果不确定时，先核对当前目录和偏好，不盲目重试；这不是
跨断线、应用重启的恰好一次交付。

## 启用

`profiles.activate({id,revision,preferencesRevision})` 始终请求原生用户确认。
宿主提供配置名和已知变更分组，插件不能替换审批文案。等待对话框时不持有设置
写锁、策略锁或数据库锁。拒绝返回 `profiles.activation.denied`，不修改偏好。

确认后，共用设置写入队列及最终事务复查两种版本。保存正文或当前偏好变化分别
返回 `profiles.conflict`、`preferences.staleRevision`。仅将公共值应用到当前
原生设置，保留私有界面提供者选择和更新元数据。偏好、新偏好版本及选中 ID
原子保存；即使调用方离开也发布已提交的原生效果和事件。移除的代理沿用现有
凭据清理流程。

返回 `{version:1,id,revision,preferencesRevision}`。`activeId` 表示最后一次
明确选择，不承诺当前设置与正文完全相同。不会静默重启，沿用现有重启提示。

## SDK

```js
const profiles = createProfilesClient(host);
const current = await profiles.catalogue({ signal: owner.signal });
const saved = await profiles.save(
  { name: "工作", revision: current.revision, values: publicValues },
  { signal: owner.signal, timeoutMs: 90000 },
);
const preferences = await host.call("preferences.snapshot", {}, { signal: owner.signal });
await profiles.activate(
  { id: saved.id, revision: saved.revision, preferencesRevision: preferences.revision },
  { signal: owner.signal },
);
```

另提供 `rename`、`remove`。每次写操作必须绑定所属方信号及一次总操作期限，默认
90 秒、最多 120 秒。保存会在第一次等待前捕获输入，校验完整公共值，以 UTF-8
边界分段上传并核对确认和结果。每客户端最多四个未结算写操作，包含清理。失败
上传会用独立信号和额外一秒清理期限尝试丢弃草稿，运行退出和过期回收作为后备。
忽略取消的传输可能延迟结算并持续占用额度。不会自动重试写入。分发所引用 SDK
模块，并使用支持取消与期限的传输；不需要用户 Node 运行时。

错误包括 `profiles.mutation.invalidRequest`、`profiles.draft.notFound`、
`profiles.draft.incomplete`、`profiles.draft.invalidOffset`、
`profiles.draft.limit`、`profiles.draft.busy`，已有名称/大小/冲突错误、
`preferences.invalidValue:<公共字段>` 及授权/取消错误。非预期内部信息统一为
`profiles.mutation.unavailable`，不返回用户值或原始数据库错误。
