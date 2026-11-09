# 插件

[English](plugins.en-us.md)

概览与兼容性：[中文](plugins-overview.zh-cn.md) · [English](plugins-overview.en-us.md)。
API 兼容性与安全：[中文](plugin-api.zh-cn.md) · [English](plugin-api.en-us.md)。
编辑器命令与格式化贡献：[中文](editor-plugins.zh-cn.md) · [English](editor-plugins.en-us.md)。

## 快速访问与命令结果

启动失败的通知提供**打开日志**入口。软件版本不兼容时，会显示已安装的插件版本、当前
Tunnelde 版本和清单中 `engines.tunnelde` 的实际范围，并在尝试启动运行环境之前停止。
请更新 Tunnelde 或安装与当前软件兼容的插件版本。较早的最低版本允许后续兼容的公测版，
但明确的版本上限和最低正式版要求仍会检查。诊断日志记录检查阶段及上述版本信息，
不再只留下内部错误码。安装插件与授权使用 Node 是独立的步骤。

插件浏览器每页最多显示 24 个匹配项，提供前后翻页和结果数量。搜索支持多个词和精确标签筛选：
`tag:pdf,image` 匹配任一标签，`tag:pdf tag:preview` 则要求两个条件同时满足。点击标签会修改搜索表达式，
不会另加一条筛选栏。打开详情时保留查询、标签和页码；点击详情中的标签会打开插件浏览器。
发现插件只读取元数据，不启动代码。每个来源的静态索引最多 2 MiB、2,000 项，安装时才下载安装包。
这是缓存元数据的界面分页，不是服务端分页协议。

清单与索引都可声明 `tags` 数组：最多 24 项，忽略大小写后不得重复；每项最多 64 UTF-8 字节，
可使用字母、数字、`_`、`-` 和 `.`。没有标签的旧插件仍可使用。

按 F1，输入 `>` 和插件名或命令名，即可打开已贡献的视图或执行已安装命令。显示列表不启动 Node，
执行仍需运行时同意与插件审批。没有视图的命令会打开宿主管理的结果页，支持滚动、调整大小、复制、
清空和命令按钮。**设置 → 键盘快捷键**列出已安装插件的命令与视图，绑定随配置方案导入导出。

`workspace.showQuickAccess`、`workspace.setPaneLocked`、`workspace.resizeSplit` 需要
`workspace.write` 权限。快速访问可预填查询，但不会自动执行。

AI 视图按用户轮次折叠中间消息、原生思考摘要和工具活动；最终回答与审批保持可见。输出有大小限制，
按文本或 Markdown 渲染，不执行任意 HTML。不能直接安装任意 VSIX：VS Code 扩展依赖其扩展宿主、
工作区服务、WebView 和认证接口，仅解包无法提供这些能力。独立编码扩展通过结构化协议调用其实际 agent 二进制。

[独立插件市场](https://github.com/TunneldeDev/Tunnelde-hub)包含可分别安装的扩展；
安装前查看各自的功能、兼容要求和权限。可执行插件在独立进程中通过 stdio JSON-RPC 2.0 通信；
纯主题包只含清单与配色，不启动进程，也不需要 Node。

## SSHFS 与声明式插件（0.27.0 起）

挂载提供者可使用原生挂载面板，声明式插件无需 Node。先连接已保存 SSH 主机，再选择连接、
浏览远端目录，并选择空的本地目录或未使用的 Windows 盘符。默认只读；挂载需手动操作，
复用 SSH 连接的认证、主机密钥信任、代理和跳板。

系统需具备兼容的 FUSE 和 SSHFS。面板检查驱动及 passive/stdin 传输支持，提供安装说明，
不会自动安装系统组件。卸载前关闭文件；忙碌的挂载可重试或明确选择强制卸载。撤销插件或断开连接会
立即切断认证传输，即使操作系统清理失败。失败状态保留以供重试；实际行为仍需结合驱动进行平台验收。

`mounts.read` 覆盖依赖检测与自身挂载列表，`mounts.write` 覆盖挂载与卸载。
插件不能卸载其他插件的资源，也不能读取 SSH 密码或私钥。Node 插件可调用
`mounts.dependencies`、`mounts.list`、`mounts.mount`、`mounts.unmount`。

声明式插件设置 `runtime: "declarative"`，并让 `main` 指向本地 JSON：

```json
{ "views": { "main": { "title": "远端挂载", "blocks": [{ "type": "mounts" }] } } }
```

在清单的 `views` 中声明 `main`。这种包没有可执行命令，不执行 JavaScript，也不查找 Node；
仍需审批所声明的权限并验证包指纹。视图可通过 F1 打开。

助手聊天块可提供 `commands.target` 和 `execution`，后者包含 `kind`、机器显示信息、
SSH 的 `sessionId`/`hostId`、`cwd`、`home`、`platform` 以及可选的可执行程序/运行时覆盖值。
宿主独立于模型提供机器选择器；没有此命令的旧块保留旧配置选择器。扩展应核对已连接目标，并按会话保存选择。

`files.sftp.resolveDirectory`（0.25.0 起）接受 `{sessionId,path?}`，返回 `{home,path}`，
通过 SFTP 元数据解析账户主目录、`~`、相对路径和规范工作目录，不列举文件，也不执行 shell。
调用需要 `sftp.read` 和可执行插件审批。

## 目录与清单

```text
hello/
  tunnelde-plugin.json
  index.js
```

`tunnelde-plugin.json` 字段：

| 字段                | 必需     | 说明                                           |
| ------------------- | -------- | ---------------------------------------------- |
| `id`                | 是       | 小写字母、数字、`-`、`_`，最多 64 字符         |
| `name`              | 是       | 显示名称                                       |
| `version`           | 是       | `major.minor` 或 `major.minor.patch`           |
| `apiVersion`        | 是       | 当前为 `1`                                     |
| `main`              | 依运行时 | 包内入口；纯主题包省略                         |
| `runtime`           | 否       | `node`（默认）、`wasm`、`theme`、`declarative` |
| `description`       | 否       | 列表中的简述                                   |
| `commands`          | 否       | `[{"id":"greet","title":"问候"}]`              |
| `views`             | 否       | `[{"id":"status","title":"状态"}]`             |
| `permissions`       | 否       | 声明的宿主权限；代码执行仍需审批               |
| `themes`            | 否       | 一种或多种配色；纯配色包需提供                 |
| `engines`           | 否       | `tunnelde` 及 Node 插件的 `node` 版本范围      |
| `tags`              | 否       | 搜索标签，如 `["files","preview"]`             |
| `fileIconThemes`    | 否       | 声明式文件名、后缀与图标映射                   |
| `filePreviews`      | 否       | 声明式后缀与预览渲染器映射                     |
| `mountedFileReveal` | 否       | 允许通过自身挂载在本机文件浏览器定位远端路径   |

运行环境与版本要求属于清单元数据，市场会直接显示。`engines` 使用 Rust semver 范围语法。
`theme` 运行时可只提供配色、文件图标或预览。Node 命令可声明 `keybindings`、
`macKeybindings`、`editor` 和 `fileMenu`；验证规则见[编辑器贡献](editor-plugins.zh-cn.md)和 SDK。
只有已安装插件的绑定才会显示。冲突可保留、选择一个，或跳到快捷键设置以
`@is:conflict` 和 `@plugins:plugin-id,another-id` 筛选解决。

宿主版本范围包含应用的预发布版本，同时保留各比较条件的上下限。例如
`>=0.29.0-beta.2` 接受 `0.32.0-beta.4`，但 `>=0.32.0` 和 `^0.31.0` 均不接受
这个 Beta。兼容插件因此可在较新的公测版运行，无需删除其版本上限。
Node 版本范围仍遵循运行时的常规 SemVer 规则。

**软件不内置 Node。** 使用系统已有 Node 前先询问用户；也可明确选择可执行文件，或按需安装私有运行时。
插件停止、更新、卸载或应用退出时，其宿主管理的进程会结束。

**设置 → 插件**显示路径与版本，可检测、手动选择和撤销系统运行时授权。检测读取 PATH
（Windows 还包括用户 PATH）或 Unix 默认登录/交互 shell，不递归搜索磁盘。没有授权时不执行系统 Node；
`TUNNELDE_NODE` 也只在取得系统运行时授权后使用。

优先级为手动选择的程序、已安装私有运行时、明确授权的系统运行时。按需安装的 Node 24 LTS
从 nodejs.org 下载并核对官方 SHA-256，安装在应用数据的 `runtimes/node/`。安装可取消，
不改 PATH、shell 配置或系统安装，仅安装运行程序；插件须自带依赖。

Node 以用户本机权限执行；清单权限**不是操作系统沙箱**，只应信任可靠发布者。WASM 使用受限运行时。

## 主题包

任意插件可通过 `themes` 提供多种主题。纯主题包使用 `runtime: "theme"`，省略 `main` 和
Node 引擎要求，不声明命令、视图或权限：

```json
{
  "id": "my-themes",
  "name": "我的主题",
  "version": "1.0.0",
  "apiVersion": 1,
  "runtime": "theme",
  "themes": [
    {
      "id": "midnight",
      "name": "午夜",
      "appearance": "dark",
      "accent": "#7298ff",
      "colors": { "background": "#101522", "sidebar": "#171e2e", "terminalBackground": "#101522" }
    }
  ]
}
```

最多 32 个主题，ID 唯一且名称非空。`appearance` 为 `light` 或 `dark`，可选强调色为 `#RRGGBB`。
`colors` 至少包含一个设置中认可的区域，值为六位 HEX；拒绝未知字段、CSS、脚本及无效颜色。
同一包可包含亮色和暗色主题。

主题显示于**设置 → 外观**及插件详情。应用时一次保存基础外观、强调色和完整配色；省略区域跟随基础外观。
安装不会自动改变当前主题；更新或移除插件后保留已应用颜色，直到用户另选主题。可执行插件提供的配色无需启动代码。

## 文件图标主题

从市场、ZIP 或文件夹安装后，在**设置 → 文件 → 文件图标主题**选择自动、普通图标或指定主题。
自动按插件/主题 ID 顺序选首个可用主题；明确选择可避免安装其他包后改变。详情也有应用入口。
移除已选包后回退普通图标，并保留身份以便重装。

插件无需运行代码即可贡献 `fileIconThemes`：

```json
{
  "id": "my-icons",
  "name": "我的文件图标",
  "version": "1.0.0",
  "apiVersion": 1,
  "runtime": "theme",
  "permissions": [],
  "fileIconThemes": [
    {
      "id": "common",
      "name": "常见文件",
      "icons": {
        "typescript": { "symbol": "code", "color": "#3178c6", "label": "TS" },
        "archive": { "symbol": "archive", "color": "#c5a35e" }
      },
      "extensions": { "ts": "typescript", "tar.gz": "archive" },
      "fileNames": { "Dockerfile": "typescript" }
    }
  ]
}
```

先匹配完整文件名，再匹配最长后缀，均忽略大小写。本地/远端的各视图、编辑标签和预览标题共用解析器，
仅读取名称；目录保留应用目录图标。主题选择随设置和配置方案导出。

每包最多 16 个图标主题；每主题最多 256 个定义、512 个后缀映射、128 个文件名映射。
定义与主题 ID 遵循插件 ID 语法，后缀不含开头的点。可选 `defaultIcon` 必须引用已有定义。
符号包括 `file`、`code`、`json`、`text`、`image`、`audio`、`video`、`archive`、`pdf`、
`spreadsheet`、`terminal`、`settings`、`key`、`database`、`font`、`binary`、`markdown`。
颜色为六位 HEX，标签为 1–4 位 ASCII 字母/数字。无效引用、忽略大小写的重复映射和过量贡献会被拒绝。
宿主绘制图形或短标记，清单不能注入 SVG、脚本、URL、样式表或字体。纯数据包可在受限模式工作，
无需 Node 或文件权限；可执行插件也可独立于运行时提供这些元数据。

## 协议

stdin/stdout 每行一个 JSON 对象；stderr 只记录日志，不解析为协议。宿主向插件发送请求，
插件以相同 `id` 返回 `result` 或 `error`：

| 方法          | 参数                    | 返回                                             |
| ------------- | ----------------------- | ------------------------------------------------ |
| `initialize`  | `{apiVersion,pluginId}` | 任意 JSON，常见为 `{"ok":true}`                  |
| `command.run` | `{command,input?}`      | 任意 JSON；交互工具可返回 `{text,title?,error?}` |
| `view.render` | `{view,locale?}`        | `{title?,blocks:[...]}`                          |
| `shutdown`    | `{}`                    | 任意 JSON，然后退出                              |

插件向宿主的通知使用相同封装但不含 `id`：

```json
{ "jsonrpc": "2.0", "method": "log", "params": { "level": "info", "message": "ready" } }
```

超时：初始化 8 秒、视图渲染 20 秒、命令与插件调用宿主 120 秒；具体服务可有更短限制。

## 宿主 API 与 SDK

Node 插件处理命令时可向宿主发送 JSON-RPC。双向读取并发进行，等待宿主不会阻塞命令回复。
独立市场提供无依赖的 `sdk/tunnelde-plugin.mjs`、TypeScript 声明，以及生成的 `sdk/api.md`、`sdk/api.json`。

```js
import { createPlugin } from "./tunnelde-plugin.mjs";
createPlugin({
  async run(command, input, host) {
    if (command !== "report") throw new Error("未知命令");
    const snapshot = await host.call("hosts.snapshot");
    const layout = await host.call("workspace.snapshot");
    await host.call("storage.set", { key: "lastReport", value: Date.now() });
    return { text: JSON.stringify({ snapshot, layout }, null, 2) };
  },
});
```

示例需声明 `hosts.read` 与 `workspace.read`。`host.describe()` 返回
`{version:1,methods:[{name,permissions,params,description,stability,since,deprecated}]}`。
`stable` 才是兼容承诺；`experimental` 尚可调整；`deprecated` 提供迁移说明。稳定方法通过
`since` 标明首次支持版本。发现 API、插件自身存储和带插件身份的通知无需领域权限，但执行已安装代码仍需审批。
未知方法与权限被拒绝。

稳定的 `api.describe` 接受空对象，返回协议 `version:1` 和方法数组。原有 `name`、`permissions`、
`params`、`description` 保留，客户端须忽略新增字段和未知稳定性值。`params` 是说明文字，
不是机器校验 schema。运行时被停止、授权撤销或通信超限都可能失败。结果仅为快照，每次后续调用独立校验，
列出方法不等于授权。旧宿主可能没有稳定性元数据，此时应视为未知。稳定方法保留已记录的请求、响应和授权行为，
允许添加字段与方法；破坏性变化须明确版本化迁移。实验接口没有同样承诺。

固定的[请求](../tests/fixtures/plugin-compat/api-describe-v1-request.schema.json)和
[响应](../tests/fixtures/plugin-compat/api-describe-v1.schema.json)定义发现协议 v1 的兼容下限。
请求仍受帧大小限制，客户端应发送空对象。发现调用不发事件。CI 校验宿主实际序列化结果、权限与元数据；
schema 允许新增字段和未知稳定性值，不代表其余方法均已有完整的输入/输出 schema。

稳定核心还包括 `sessions.list` 和插件自身的 `storage.get`、`storage.set`、`storage.delete`。
稳定条目通过可选的版本化 `contract` 提供输入、返回值和错误的 JSON Schema。字段契约、
配额、错误和冻结的旧 SDK 回归探针请参阅 [API 兼容性](plugin-api.zh-cn.md)。

| 权限                                | 操作范围                                                          |
| ----------------------------------- | ----------------------------------------------------------------- |
| `app.read`、`app.openExternal`      | 应用/平台元数据、经验证 HTTP(S) 浏览器链接                        |
| `settings.read`、`settings.write`   | 读取偏好、合并并校验补丁                                          |
| `hosts.read`、`hosts.write`         | 主机/分组元数据及增删改、顺序和使用记录                           |
| `sessions.read`、`ssh.exec`         | 连接列表、正常密钥验证后的连接、断开、独立通道命令、终端输入/尺寸 |
| `fs.read`、`fs.write`               | 本地目录、UTF-8 读写、创建、重命名、复制、删除                    |
| `sftp.read`、`sftp.write`           | 通过现有 SSH 连接进行对应远端文件操作                             |
| `editor.read`、`editor.write`       | 读取/替换编辑缓冲，核对文档身份和版本                             |
| `mounts.read`、`mounts.write`       | 依赖检测和自身 SSHFS 挂载                                         |
| `forwards.read`、`forwards.write`   | 转发规则及监听器                                                  |
| `monitor.read`、`monitor.write`     | 本地/远端指标、远端进程及经校验 TERM 请求                         |
| `history.read`、`history.write`     | 主机命令历史的列举、记录、删除、清空                              |
| `workspace.read`、`workspace.write` | 标签和布局，打开、激活、关闭、移动、拆分、停靠                    |
| `clipboard.read`、`clipboard.write` | 明确的文本剪贴板访问                                              |
| `log`                               | 带插件身份、有大小限制的日志                                      |
| `network`                           | 声明 Node 网络用途，不提供操作系统网络沙箱                        |
| `process.exec`                      | 明确选择的本地流式进程，不自动发现运行时                          |
| `secrets`                           | 插件自身系统凭据库，不包含 SSH 密码或私钥                         |

0.22 起提供 `events.publish`、插件自身 `tasks.*`、有作用域的 `tools.*` 和持久 `runners.*`。
`tools.invoke` 接受 `ask`、`approve`、`full`、`readOnly`，以及本地根目录、SSH 会话/主机、远端根目录。
只读拒绝命令和修改；询问模式确认命令和修改；代审批由受信任插件的独立审查者处理，失败回退人工；
完全访问跳过逐项审批。规范路径和内容哈希保护支持的文件工具，不沙箱化任意 shell 或受信任 Node。
撤销客户端会取消待处理请求及其任务/传输。

`tasks.readOutput` 会在同一次快照中返回带序号的输出及 `status`、`exitCode`、可选的 `error`。
输出事件全部读取后，错误详情仍会保留。存在详情时应直接展示，避免把 SSH 通道断开等故障
统一描述为可执行文件或登录问题。旧宿主可能省略此字段，`tasks.status` 也提供错误详情。
报告失败前须读完已结束进程的输出，保留 agent 最后的协议响应。

视图可声明 `location:"sidebar"`、`kind:"chat"` 及认可的活动图标，提供可停靠受控聊天面板。
`view.render` 返回包含会话、模型和审批控件的 `chat` 块，后续 `events.publish` 发送带序号的更新。
移动面板保留草稿。密钥放 `secrets.*`，不要放视图或普通存储。完整结构见 SDK，具体控件见各扩展说明。

运行中、可恢复和当前操作失败的任务直接显示；其他已结束任务收入默认折叠的历史列表，
显示数量及失败提示。展开历史不会继续执行任务。审批详情可使用纯文本或 JSON，宿主仅对
JSON 做格式化展示，不改变审批请求或用户决定。

聊天任务条目可提供 `runId`，标识拥有其恢复记录的操作。检查／继续命令会收到该条目的 `taskId`、
`taskRunId` 和当前会话的 `runId`。插件必须在读取或继续进程前校验所有传入的身份。旧任务的恢复游标
被替换后，应停止提供恢复操作；旧入口不能静默操作后来的进程或同一 runner 上的新任务。

0.25.1 起，会话选择器支持搜索及每行重命名/删除。`commands.session` 接受
`action:"select"|"new"|"rename"|"delete"`，现有会话带 `sessionId`，重命名另带 `title`。
重命名/删除须直接操作该 ID，不先切换会话；删除活动会话可选择剩余会话。拒绝空名、过长名称和删除运行中会话。
条目可含 `untitled`、`updatedAt`（Unix 毫秒）、`running`、`runId`；本地化占位标题使用空标题和
`untitled:true`，自定义名称用 `false`。匹配 `runId` 的后台终端事件清除运行指示，不改变可见会话。

0.22.2 起，聊天块可含 `title` 和 `profilePolicy`，后者含 `primaryProtocols`、`reviewerProtocols`、
`defaultProtocol`，默认协议必须属于主协议。宿主用它展示插件身份并区分 agent 与仅审批 API。
插件加载、保存和执行时也必须强制固定策略；视图元数据不是授权边界。各扩展分别拥有视图、存储、权限和运行时。

远端持久 runner 需要明确确认、单独选择的原生 helper、新建私有远端目录及明确的远端运行时；
不安装服务或 Node。关闭应用保留远端任务；停止插件或进入受限模式会记录停止意图，重连后重试不可达主机。
runner 记录绑定已保存主机，新连接 ID 可用于恢复同一任务，见[原生 helper](native-helper.md)。

可选 `tunnelde-agent` 支持 MCP stdio 和远端 runner，普通 SSH、SFTP、终端、本地 API 聊天不需要。
二进制与校验和由独立的 Tunnelde-agent 仓库维护并发布；不放在桌面安装器或主 GitHub Release 下载中。

主机/会话快照不返回密码和私钥。没有通用 Tauri 调用、凭据库访问、自动信任密钥、自我审批或关闭受限模式接口。
现有校验与覆盖规则仍生效。关闭脏编辑器会询问用户并返回 `pendingConfirmation`，插件不能静默丢弃草稿。
文件、历史、设置和主机变化会刷新对应 UI。`ui.confirm` 标识插件，不替换已有弹窗。
`terminal.write` 接受普通 UTF-8 文本，不接受 base64。

参数必须是对象，最多 256 KiB；帧和返回值上限约 1 MiB。本地文本读写最多 512 KiB，拒绝二进制；
远端使用编辑器 2 MiB 上限，同时仍受更严格的 API 请求/响应限制。读取返回 `{content,size}`。
插件自身 JSON 存储总计最多 256 KiB，位于安装包目录外。每个 Node 进程最多 32 个在途宿主调用，
宿主向该进程发出的命令与视图请求也最多同时 32 个；超出任一上限返回 `plugin.api.busy`，不会无限排队。
异步 Node 命令等待结果时，其他命令和视图渲染仍可执行；插件需处理回调重叠，并避免长时间同步计算。
停止、撤权与进程退出会拒绝尚未完成的请求；重启后的插件使用独立的请求状态。
工作区请求每插件最多 8 个、全局 64 个。SSH 命令限制 100–60000 毫秒、stdout/stderr 合计 1 MiB，
返回 `{stdout,stderr,exitCode,signal}`；取消关闭专用通道，无法撤销已执行命令。

`files.upload`/`files.download` 使用 `{sessionId,localPath,remotePath,overwrite?}` 传输二进制或目录，
立即返回传输 ID，使用公共进度 UI，完成后刷新目标。`files.cancelTransfer({transferId})` 只取消当前插件运行代次
启动的传输。撤销、受限模式、停止或进程退出会取消活动传输；其他插件或替代进程不能取消。
原有覆盖、链接和递归复制保护仍适用。

插件传输与用户传输使用相同的持久暂存与最终提交机制，事件可包含 `pluginId` 标明来源。
取消或撤权后先停止新工作，等待活动写入结束，再清理临时文件。目标断线时保留清理任务，重连后重试。
应用重启后，未完成的插件传输只进行清理，不会沿用已失效运行实例的权限恢复执行。
任务列表支持取消、限速和清理；暂停与恢复只用于用户传输，需要重试时请从插件重新发起。
源文件和已经提交的目标文件会保留。

`files.local.copy({from,to,overwrite?})` 与 `files.sftp.copy({sessionId,from,to,overwrite?})`
也使用持久任务引擎，遵循相同的运行代次、取消、暂存与提交规则。原有完成契约保持不变：工作结束后才返回
`null`，取消或失败会拒绝调用。目录逐文件提交，失败时保留已提交文件。取消尚未结束的 `tools.invoke` 复制请求
会通知工作任务停止，等待在途读写收尾后清理暂存文件。调用端 RPC 超时不能视为已经回滚的证明。
长传输优先使用上传／下载返回的任务 ID 查询进度，避免复制 RPC 超过 SDK 调用超时。

用 `files.transferStatus({transferId})` 等待完成，返回 `running`、`done`、`failed`、`cancelled` 或 `cleanupPending` 事件，
找不到、已过期或不属于本运行代次时返回 `null`。内存只保留最近 256 个完成事件，每插件最多 8 个并发传输。

SDK 默认调用超时 30 秒，可用 `{signal,timeoutMs}` 调整，最多 120 秒。长 SSH 命令和人工确认需适当延长。
失败的写入不能在未确认结果前自动重试。

## 审批与受限模式

安装后插件保持停止。首次明确启动、打开工具或执行时，显示发布者/来源和权限，可允许、拒绝或进入受限模式。
授权绑定安装包与权限的 SHA-256 指纹；更新、改文件、重装均需重新审批，即使 ID 和版本相同。
审批期间包变化会被拒绝。使用系统 Node 的同意是单独选择。

**设置 → 插件**提供受限模式和逐插件撤权。受限模式禁止 Node/WASM 启动、命令与可执行视图，
纯主题和市场管理仍可用。进入受限模式或撤权先使授权失效，再停止进程，取消待处理请求及该插件确认框。
每次请求与异步回复均重新检查授权。

可通过命令行强制进入：

```text
tunnelde --safe-mode
tunnelde --restricted-mode
```

Windows 使用 `tunnelde.exe --safe-mode`；macOS 使用 `open -a Tunnelde --args --safe-mode`。
发送给已有单实例也会生效。CLI 强制状态在本进程中不可关闭，重启且不带参数后设置开关才可用。
受限模式会持久保存，去掉参数不会静默恢复插件。

插件执行后异常退出或安全状态损坏时，启动进入受限模式并提供恢复指引。运行失败/超时提供一次建议，
不反复叠加弹窗。正常退出清除恢复标记；授权独立于外观重置。

Node 以用户操作系统权限运行；清单权限保护宿主 API，**不限制 Node 直接访问文件、进程或网络**。
受限模式停止宿主管理的代码并阻止宿主 API，不能撤销已写数据或任意代码另启的外部进程。

## WASM 插件

清单设置 `runtime:"wasm"`，`main` 指向 `.wasm`。省略运行时则默认 Node。
扫描目录时编译模块，启动/停止无需另起进程。模块须导出：

| 导出            | 签名                     | 说明                      |
| --------------- | ------------------------ | ------------------------- |
| `memory`        | 线性内存                 | 至少 327680 字节，即 5 页 |
| `tunnelde_call` | `(i32,i32,i32,i32)->i32` | 请求处理器                |

宿主在偏移 `1024` 写入 JSON，以 `in_ptr=1024`、`out_ptr=65536`、`out_cap=262144`（256 KiB）
调用 `tunnelde_call(in_ptr,in_len,out_ptr,out_cap)`。模块把结果写入输出缓冲，返回字节数，宿主解析为 JSON。
请求没有 JSON-RPC 封装：

```json
{ "method": "run", "command": "greet" }
{ "method": "render", "view": "status" }
```

唯一导入为 `env.log(level:i32,ptr:i32,len:i32)`，读取 UTF-8 日志，最多 8 KiB；
`level>=2` 为警告，否则为信息。每次调用使用新 store，不保留 guest 内存状态。
此 ABI 不提供异步 Node 宿主 API；每次限制 1,000 万 fuel、64 MiB 内存、一个实例和两张表。
仍需执行审批并遵守受限模式；无限循环耗尽 fuel 后终止。

## 视图

`view.render` 返回由宿主绘制的声明式块：

```json
{
  "title": "状态",
  "blocks": [
    { "type": "heading", "text": "集群" },
    { "type": "text", "text": "三个节点" },
    { "type": "kv", "items": [{ "label": "运行时间", "value": "12d" }] },
    { "type": "table", "columns": ["节点", "角色"], "rows": [["db-1", "primary"]] }
  ]
}
```

忽略未知块类型，普通字符串最多 4,000 字符，表格最多 12 列、200 行，不执行插件 HTML。
交互视图可增加含 ID、`fields` 和 `actions` 的 `form`。字段支持 `text`、`textarea` 和带 value/label
选项的 `select`。动作声明 ID、标签和清单命令 ID。宿主校验并绘制控件，将字符串字段及 `_locale`
放入命令 `input`，提供明确的复制结果按钮。输入最多 256 KiB，结果最多 1 MiB。
切换或移动标签保留草稿和结果，关闭标签丢弃。原只读视图继续可用；完整 schema 见市场说明。

## 插件市场

官方索引为 `https://raw.githubusercontent.com/TunneldeDev/tunnelde-hub/main/registry.json`，
在独立市场仓库维护。旧 `marketplace/index.json` 保留为老客户端兼容快照。
**设置 → 插件**含官方来源最多可配 20 个来源。自定义来源需公开 HTTPS JSON，并明确确认信任。
禁用/移除来源不删除已安装插件；当前不支持需要认证的来源。

每项固定下载地址与校验和：

```json
{
  "plugins": [
    {
      "id": "hello",
      "name": "Hello",
      "version": "0.1.0",
      "description": "示例插件",
      "url": "https://github.com/<owner>/<repo>/releases/download/<tag>/hello-plugin.zip",
      "sha256": "<64 hex characters>"
    }
  ]
}
```

索引可含 `author`、内联 `readme`、`runtime`、`apiVersion` 和 `engines`。清单里的 `readme`
则是包内相对路径，宿主在包内安全地读取有大小限制的内容。Node 引擎要求使用 Rust semver 范围语法。

插件活动栏提供市场、已安装和更新筛选。选结果打开可复用的详情标签。Rust 执行下载，不受 WebView CORS 限制，
提供进度、取消和重试。HTTPS 最多五次重定向，压缩包最多 64 MiB，解压后最多 64 MiB/2,000 项。
解压前核对校验和，并核对包 ID、版本、运行时和 API 与索引一致。校验和验证完整性，不证明发布者身份。

每来源独立缓存五分钟；刷新失败可显示带原时间戳的离线快照。单个来源失败不阻塞其他来源。
无效条目跳过，索引文档格式损坏则失败。已安装插件记录来源 ID 和 URL；更新须来自原来源且版本更高。
更新由用户操作：先校验暂存，停止旧插件，再原子替换；失败恢复旧包，启动时恢复中断替换。
安装/更新后插件保持停止。本地插件不能被同 ID 的远端索引静默接管。
来源和运行时配置独立于外观及一般偏好重置。

向独立市场提交源码、清单、README 和重新生成的 `registry.json`。确定性归档包含根 LICENSE。
`npm run verify` 校验目录、验证器、算法及真实 JSON-RPC 进程，`npm run package` 在
`artifacts/plugins/` 生成 ZIP、SHA256SUMS 和索引。Push/PR 检查与每周已发布包审计独立于桌面发布。
先发布并验证版本化归档，再合并索引。旧官方来源和包归属会迁移到独立市场，保留自定义来源与 Node 同意状态。

## 安装

扩展分别声明软件版本和运行时要求。查看市场详情和自身说明以了解初始化与运行位置；
使用系统已有 Node 前会询问用户。

- **插件侧栏 → 安装插件**校验清单后复制到应用数据的 `plugins`，拒绝覆盖已有 ID。
- ZIP 根目录或唯一顶层目录须含清单；解压拒绝路径逃逸并限制总大小。
- 可选择文件夹、压缩包，或在安装对话框打开时拖入。
- **重新加载**先停止正在运行的宿主，再扫描目录。
- **卸载**停止宿主并移除安装文件夹。
- 仓库 `examples/plugins/hello` 是完整的最小示例。

## 文件预览提供者

通过 `filePreviews` 声明一种或多种提供者。宿主负责读取和渲染，插件不接收文件字节或预览票据。
纯主题/图标/预览包使用 `runtime:"theme"`，不含 `main`、命令、视图或权限，不需要 Node。
可执行包也可贡献提供者：

```json
{
  "filePreviews": [
    { "id": "pictures", "name": "图片", "renderer": "image", "extensions": ["png", "jpg", "gif"] },
    { "id": "pdf", "name": "PDF", "renderer": "pdf", "extensions": ["pdf"] }
  ]
}
```

渲染器为 `image`、`audio`、`video`、`pdf`、`markdown` 或 `text`。ID 遵循插件 ID 语法，
名称最多 120 UTF-8 字节。每包最多 16 个提供者，每个 1–128 个后缀，忽略大小写后唯一，
每项最多 64 ASCII 字节。拒绝 URL、HTML、脚本、样式和外部查看器，需声明支持版本的 `engines.tunnelde`。

选文件按空格或使用预览入口。匹配忽略大小写并支持复合后缀。多提供者时显示选择器，否则安装即可使用。
缺少二进制提供者时可按 `preview` 标签搜索市场；内置文本/Markdown 不需要插件。
安装/移除后立即刷新提供者。

原生预览票据使用不透明 UUID，闲置 30 分钟过期，关闭预览或销毁窗口后撤销，保留已打开句柄，
不把任意协议路径映射为文件。最多八张票据，每票据两个并发请求；支持 GET/HEAD 与单段 Range，
每段最多 1 MiB，拒绝 multipart Range；整文件读取最多 32 MiB。
撤销会中断排队/活动读取，远端文件与 SFTP 句柄关闭，不创建远端临时文件。

图片最多 32 MiB、PDF 128 MiB、文本/Markdown 2 MiB；音视频用受限 Range 请求，
依赖系统解码器且只在用户操作后播放。PDF.js 按需加载本地字体/CMap/解码器，
按需读区间，每次在有大小限制的 canvas 渲染一页，不执行文档脚本或交互表单。
有密码的 PDF 需用外部查看器。

[稳定的插件底栏 API](plugin-status-bar.zh-cn.md)

[标签栏扩展](plugin-tab-bar.zh-cn.md)

[本地日志与插件诊断](logging.zh-cn.md)
