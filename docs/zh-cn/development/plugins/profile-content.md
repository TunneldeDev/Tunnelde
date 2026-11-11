# 公共 Profile 正文

实验接口 `profiles.catalogue` 和 `profiles.read` 需要 `settings.read`、当前插件批准
及运行代次授权。通过 `api.describe` 探测支持，不授予写入或激活权限。

`profiles.catalogue({})` 返回 `{version:1,revision,activeId,items}`，元数据保留
原生顺序与最多 32 项的限制。不透明的正文修订号与历史 `profiles.observe` 元数据
修订号独立，不能混用。它识别历史写入者造成的正文变化，以及当前写入者的同内容
重复保存。`activeId` 记录最后一次明确的原生选择，不代表当前设置与正文相同；
只改变选中项不会改变正文修订号。

`profiles.read({id,revision,offset,limit})` 返回
`{version:1,id,revision,offset,totalBytes,text,nextOffset}`。位置和上限均按 UTF-8
字节计算；`limit` 为 4–65536，起点必须是字符边界。沿 `nextOffset` 读取至 null，
拼接 text 后解析 JSON，得到遵循公共 Schema 的 11 个 `PreferenceValues` 分组。
不返回私有提供者选择、运行元数据、凭据或原生存储键，不能当作原生 Settings 文档。

JSON 转义可能使分段缩短，以保持编码响应不超过 128 KiB；每篇正文最多 16515072
字节。原有原生集合及导入文件的限制不变，不以导入文件上限缩小旧保存正文的范围。
非法旧正文返回 `profiles.content.invalidContent`，不静默修复。非法请求、非法
字节范围、ID 不存在、集合变化分别返回 `profiles.content.invalidRequest`、
`profiles.content.invalidRange`、`profiles.notFound`、`profiles.conflict`。
发生冲突应重新读取目录，再明确发起新读取，不能拼接不同版本。

最多四个后台工作者，取消后未结算仍占额度，每页操作前后复查授权。正文投影不
持有数据库锁；不可变投影缓存最多 30 秒、四项、32 MiB。命中缓存仍检查当前存储
修订号及授权。读取不会启动会话、文件系统或插件运行环境。

SDK 自动组装并校验公共值：

```js
import { createProfilesClient } from "./sdk/profiles/client.mjs";

const profiles = createProfilesClient(host);
const catalogue = await profiles.catalogue({ signal: viewLifetime.signal });
const item = catalogue.items[0];
if (item) {
  const values = await profiles.read(
    { id: item.id, revision: catalogue.revision },
    { signal: viewLifetime.signal, timeoutMs: 30000 },
  );
  showTheme(values.appearance.theme);
}
```

使用支持取消与期限的传输；基础可信 UI 的 `api.call` 本身不保证这些语义。
随客户端分发所引用的 preferences/schema.mjs、profiles 模块、runtime observation
模块及类型声明。不需要 Node 全局对象或用户 Node 运行时。结果为独立的深度冻结
对象。读取必须绑定所属方的 AbortSignal，共用一次总期限，默认 30 秒，可设
1–120000 ms；每客户端最多四个未结算操作、每次最多 4096 页。取消阻止迟到结果，
忽略取消的传输会延迟结算并继续占用额度；错误停止，不自动重试。

独立 DTO 和机器 Schema 自动镜像到 SDK。CI 使用真实 Rust 产生的大篇 Unicode/
转义正文验证 Schema 和 SDK，继续检查冻结的元数据及稳定核心消费者。这些接口
仍为实验状态；草稿写入、原子公共 CRUD 和经用户确认的激活另行实现。已有原生
控件及 `profiles.observe` 契约保留。
