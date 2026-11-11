# 文件浏览器实时数据与操作

[English](../../../en-us/development/plugins/file-browser-data.md) · [界面提供者](file-browser.md)

普通插件可以发现并操作已有文件浏览器，无须替换其界面。以下三个 RPC 均为实验接口，
使用前应检查运行中宿主的 `api.describe`。既有文件读写和界面提供者契约保持兼容。

| 方法                  | 权限                | 结果                                         |
| --------------------- | ------------------- | -------------------------------------------- |
| `fileBrowser.observe` | `fileBrowser.read`  | 已提交的浏览器元数据及目录清单条件版本。     |
| `fileBrowser.read`    | `fileBrowser.read`  | 精确面板版本下的可见条目及选中标记。         |
| `fileBrowser.action`  | `fileBrowser.write` | 分发至既有宿主行为后返回 `{accepted:true}`。 |

元数据包含临时 `paneId`、可空 `tabId`、来源、当前路径、版本、可见数量、选中数量、
忙碌/暂停状态和有界错误文字，不包含文件正文、完整选中路径、凭据、预览票据或内部状态。
筛选后保留的选中条目可能不再可见，因此 `selectedCount` 可以大于可见数量。
远端来源包含现有会话 ID；发现浏览器不会连接主机或赋予文件系统权限。

`observe({offset?,limit?,revision?})` 默认从 0 开始，每页 16 个浏览器，最多 32 个。
条件版本绑定此次清单及精确的 offset/limit；未变化的响应没有 `snapshot`。
`snapshot.nextOffset` 表示下一页偏移或 `null`。字节预算可能使实际条目数少于 limit。
每页独立捕获；翻页期间清单变化可能改变顺序，需要一致枚举时应重新发现。

`read({paneId,revision,offset?,limit?})` 默认每页 64 个条目，最多 256 个，顺序与宿主
当前筛选和排序一致，每页必须携带精确的实时面板版本。条目包含名称、路径、目录和隐藏
标记、大小、修改时间（Unix 毫秒或 null）、权限（或 null）及选中状态。
数值必须为 JavaScript 安全整数。两种分页响应均不超过序列化 UTF-8 的 64 KiB。
标识符为 1–128 UTF-8 字节且无控制字符；路径为 1–32768 字节且不含 NUL；名称最多
4096 字节。错误文字最多 2048 字节，截断时明确返回 `errorTruncated`。
JSON Schema 的字符长度约束不能替代这些字节预算和分页校验。

每个操作必须携带 `paneId` 和 `revision`：

| 操作       | 附加字段                                 | 行为                                                   |
| ---------- | ---------------------------------------- | ------------------------------------------------------ |
| `refresh`  | 无                                       | 调用既有刷新逻辑。                                     |
| `navigate` | `path`                                   | 通过既有路径处理发起导航。                             |
| `select`   | `paths`                                  | 选择最多 256 个不重复的可见条目；空数组清空选择。      |
| `open`     | `path`，可选 `mode: "open" \| "preview"` | 文件沿用编辑器和预览流程；目录转为导航，不能预览目录。 |

忙碌或暂停的浏览器拒绝操作。来源、版本变化或面板关闭会使旧请求失效。原生桥接检查
审批、权限、运行代次和取消状态，并在分发操作前再次检查授权及实时状态。
accepted 仅表示已分发，并不表示 IO 完成；应观察后续状态及宿主错误提示，丢失响应后
不可自动重放操作。错误包括 `plugin.fileBrowser.invalid`、`.changed`、`.busy` 及原生
权限、取消、响应过大错误。清单表示已提交的界面状态，不是原子文件系统快照或持久路径权限。

市场 SDK 提供独立分类的门面：

```js
import { createFileBrowserClient } from "./sdk/files/browser/client.mjs";
const browsers = createFileBrowserClient(host);
const observation = await browsers.observe();
const pane = observation.changed && observation.snapshot.items[0];
if (pane && !pane.busy && !pane.suspended) {
  const page = await browsers.read({ paneId: pane.paneId, revision: pane.revision });
  const file = page.items.find((entry) => !entry.isDir);
  if (file)
    await browsers.action({
      paneId: pane.paneId,
      revision: pane.revision,
      action: "open",
      path: file.path,
    });
}
```

`subscribe(receive,{signal,offset?,limit?,intervalMs?})` 观察指定的清单页，默认间隔两秒，
允许 1–60 秒。必须提供所属方 signal；异步接收串行执行，中间变化可以合并，每个客户端
最多八个订阅。停止/取消后不再投递，`done` 返回 stopped/aborted/failed；未结算工作仍占用
配额。读取和操作也接受 signal/timeout 参数。返回值复制并冻结，SDK 不会重试操作。

独立线协议 DTO 位于 `src/lib/extensions/contracts/files/browser/`，机器契约位于
`src-tauri/src/plugins/api/domains/files/browser/schema.json`，SDK 同步检查两者。
CI 执行真实前端桥接，再用其序列化结果验证 Schema 和固定版本 SDK。
文件正文、预览资源、安全复制移动/删除及持久文件系统回执属于其他接口范围。
