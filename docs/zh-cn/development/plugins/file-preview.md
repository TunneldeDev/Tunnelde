# 宿主文件预览观察与界面组合

[English](../../../en-us/development/plugins/file-preview.md) · [文件资源](../file-resources.md)

实验性 `filePreview` 领域开放宿主当前的快速预览弹窗。它不代表所有编辑器、
可停靠预览面板、文件系统快照或公开渲染地址。使用前检查 `api.describe` 和
`extensions.describe`；本次不扩大稳定核心，也不改变协议版本。

| 方法                    | 所需权限                                                    | 结果                                      |
| ----------------------- | ----------------------------------------------------------- | ----------------------------------------- |
| `filePreview.observe`   | `filePreview.read`                                          | 条件观察已提交的元数据，关闭时为 `null`。 |
| `filePreview.providers` | `filePreview.read`                                          | 精确预览版本对应的渲染器选项。            |
| `filePreview.action`    | `filePreview.write`                                         | 接受关闭、重试或切换渲染器操作。          |
| `filePreview.open`      | `filePreview.write`，以及来源对应的 `fs.read` / `sftp.read` | 接受显式绝对路径目标。                    |

`observe({revision?})` 返回 `{schemaVersion:1,revision,changed}`，只有变化时才包含
`snapshot`。非空快照包含激活 `id`、帧 `revision`、渲染尝试 `attemptId`、明确的
来源与路径、行列（0 表示未指定，正值从 1 开始）、`presentation:"quickLook"`、渲染类型、可空的提供者
ID、提供者数量、状态及可空错误码。它不包含正文、原生票据、URL、原始错误或回调。
观察会暴露路径，因此具有独立权限。

状态为 `loading`、`ready`、`error`、`unavailable`。就绪意味着文本已读、图片已加载、
媒体元数据已加载或 PDF 第一页已绘制；拿到原生票据不等于就绪。公开错误为
`readFailed`、`decodeFailed`、`rendererUnavailable`，详细原因仍由宿主诊断展示。
一次尝试失败后，必须重试或替换尝试才能恢复。

`providers({id,revision,offset?,limit?})` 默认 offset 0、limit 16，最多 32。
分页包含 `total`、`offset`、`nextOffset` 和按顺序排列的 `{id,name,renderer}`。
每页必须使用精确的已提交预览版本；完整分页最多 64 KiB 序列化 UTF-8，观察最多
256 KiB。标识为 1–128 UTF-8 字节且无控制字符；组合渲染提供者 ID 允许 129 字节（两个 64 字节标识加 `:`），路径为 1–32768 字节且无 NUL，
渲染器名称最多 120 UTF-8 字节。行列和数量必须为非负安全整数。JSON Schema 的字符
限制不能代替这些字节限制。

操作需要 `{id,revision,action}`。`selectProvider` 额外需要 `providerId`；`close`
和 `retry` 不接受无关字段。接受操作后，立即消耗该帧的修改资格。重试或切换提供者
产生新的尝试；再次打开同一路径产生新的激活。旧帧、旧回调和迟到结果不能影响新目标。

`open` 需要 `{source,path,line?,column?}`。来源为 `{kind:"local"}` 或
`{kind:"remote",sessionId}`；本地路径须符合宿主系统的绝对路径规则，远端路径须以
`/` 开头。原生代理会将端点读取权限保留到最终授权与回复。接受前取消可阻止提交；
接受后停止调用方不会关闭宿主持有的界面。`{schemaVersion:1,accepted:true}` 只确认
意图已接受，不代表读取或解码成功。请观察后续状态，不要在丢失回复后自动重放操作。

```js
import { createFilePreviewClient } from "./sdk/files/preview/client.mjs";
const preview = createFilePreviewClient(host);
await preview.open({ source: { kind: "remote", sessionId }, path: "/work/report.pdf" });
const owner = new AbortController();
const observation = preview.subscribe(
  (value) => {
    // null 表示已关闭；状态仅属于这一次渲染尝试。
    console.log(value?.state ?? "closed");
  },
  { signal: owner.signal },
);
// 随插件或视图所属方释放。
owner.abort();
await observation.done;
```

SDK 返回独立、冻结的数据。订阅必须有所属方 signal，串行交付，允许合并中间帧。
默认间隔两秒，允许 1–60 秒；每客户端最多八个订阅。取消后仍未结束的请求继续占用
配额直到实际结算。读取和操作也支持 signal、timeout 参数。

可信组件视图可声明 `provider:"filePreview"`，需 `ui.trusted`、`filePreview.read`
以及至少一种端点读取权限。由用户在界面提供者设置中主动选择。宿主在挂载与访问时
检查实际目标的端点；仅有本地权限的提供者遇到远端目标会回退。修改操作还需独立的
`filePreview.write`。`FrontendViewProps.filePreview` 提供元数据、`readProviders`、
关闭/重试/选择回调及可以选择是否挂载的 `Body`。挂载一次 `Body` 即可组合现有宿主
渲染器，无需重建。省略它可仅显示元数据；重复挂载或渲染异常会恢复内置界面。
语言、主题与展示提供者变化保留原渲染 DOM 和资源。目标替换、停止、撤权后，保留的
组件与回调失效。可信 UI 仍是受信任代码，不是 JavaScript 安全沙箱。

传输契约、原生代理与 Schema、已提交状态注册、渲染生命周期、界面守卫及 SDK 客户端
分别存放于各自 `files/preview` 领域。CI 检查历史消费者、Schema、真实前端生产样本
与 SDK 解析。公开字节资源属于独立的 `files.content` API，预览元数据权限不授予正文访问。
