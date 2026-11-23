# Changelog

All notable changes to Tunnelde are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.8.0-beta.5](https://github.com/TunneldeDev/Tunnelde/compare/v2.7.1...v2.8.0-beta.5) - 2026-11-23

### 更新概览 | Highlights

- **plugins:** fence native resource effects
- **errors:** unify structured failure diagnostics
- **panels:** keep detached settings tabs and icons stable
- **plugins:** align staged reads with native origin fences
- **tabs:** show insertion line while reordering

<details open>
<summary>详细变更 | Details (12)</summary>

### 新增 | New

- **plugins:** fence native resource effects ([#521](https://github.com/TunneldeDev/Tunnelde/pull/521)) @quyansiyuanwang
- **errors:** unify structured failure diagnostics ([#523](https://github.com/TunneldeDev/Tunnelde/pull/523)) @quyansiyuanwang

### 修复 | Fix

- **panels:** keep detached settings tabs and icons stable ([#519](https://github.com/TunneldeDev/Tunnelde/pull/519)) @quyansiyuanwang
- **plugins:** align staged reads with native origin fences ([#522](https://github.com/TunneldeDev/Tunnelde/pull/522)) @quyansiyuanwang
- **tabs:** show insertion line while reordering ([#524](https://github.com/TunneldeDev/Tunnelde/pull/524)) @quyansiyuanwang
- **ci:** isolate russh close-ack tests ([346f03b](https://github.com/TunneldeDev/Tunnelde/commit/346f03b398650bae36bb4003f3720acbeeba2559)) @quyansiyuanwang
- **panels:** renew native drag grants while held ([ad0211c](https://github.com/TunneldeDev/Tunnelde/commit/ad0211cb82402a4b263c668171e1fa25b6256999)) @quyansiyuanwang
- **ci:** bound macOS platform tests ([fed5d9e](https://github.com/TunneldeDev/Tunnelde/commit/fed5d9ef8ca310f7ab04b4b5e5fa5f08674f638a)) @quyansiyuanwang
- **panels:** report native drag failures ([1898fca](https://github.com/TunneldeDev/Tunnelde/commit/1898fca79e7f3819795e69e0a37582cd02fea465)) @quyansiyuanwang
- **release:** tolerate settling PR commit lists ([a191020](https://github.com/TunneldeDev/Tunnelde/commit/a191020ddc4d0c79feb56102eff56a9baa818c45)) @quyansiyuanwang
- **panels:** restore file dragging and keyboard shortcuts ([d5beeff](https://github.com/TunneldeDev/Tunnelde/commit/d5beeffb23b4c89e1ab5e73c461bc747524491fd)) @quyansiyuanwang

### 其他 | Other

- **release:** keep promotion PRs in draft ([1cd3281](https://github.com/TunneldeDev/Tunnelde/commit/1cd32810029f6ed9db30ebcd8d013120e91a0166)) @quyansiyuanwang

</details>

### 贡献者 | Contributors

@quyansiyuanwang

## [2.7.1](https://github.com/TunneldeDev/Tunnelde/compare/v2.7.0...v2.7.1) - 2026-11-22

### 更新概览 | Highlights

- **panels:** retire detached source tabs and restore icons

<details open>
<summary>详细变更 | Details (1)</summary>

### 修复 | Fix

- **panels:** retire detached source tabs and restore icons ([#517](https://github.com/TunneldeDev/Tunnelde/pull/517)) @quyansiyuanwang

</details>

### 贡献者 | Contributors

@quyansiyuanwang

## [2.7.0](https://github.com/TunneldeDev/Tunnelde/compare/v2.6.0...v2.7.0) - 2026-11-22

### 更新概览 | Highlights

- **plugins:** admit reviewed native workspace actions

<details open>
<summary>详细变更 | Details (1)</summary>

### 新增 | New

- **plugins:** admit reviewed native workspace actions ([#515](https://github.com/TunneldeDev/Tunnelde/pull/515)) @quyansiyuanwang

</details>

### 贡献者 | Contributors

@quyansiyuanwang

## [2.6.0](https://github.com/TunneldeDev/Tunnelde/compare/v2.5.0...v2.6.0) - 2026-11-21

### 更新概览 | Highlights

- **plugins:** expand origin-fenced native resource APIs

<details open>
<summary>详细变更 | Details (1)</summary>

### 新增 | New

- **plugins:** expand origin-fenced native resource APIs ([#513](https://github.com/TunneldeDev/Tunnelde/pull/513)) @quyansiyuanwang

</details>

### 贡献者 | Contributors

@quyansiyuanwang

## [2.5.0](https://github.com/TunneldeDev/Tunnelde/compare/v2.4.0...v2.5.0) - 2026-11-21

### 更新概览 | Highlights

- **plugins:** retain private declarative form drafts
- **plugins:** admit reviewed native workspace and file RPCs
- **plugins:** retain main secret draft across strict replay
- **release:** require accepted beta before stable
- **panels:** remove source placeholder after detach

<details open>
<summary>详细变更 | Details (6)</summary>

### 新增 | New

- **plugins:** retain private declarative form drafts ([#506](https://github.com/TunneldeDev/Tunnelde/pull/506)) @quyansiyuanwang
- **plugins:** admit reviewed native workspace and file RPCs ([#507](https://github.com/TunneldeDev/Tunnelde/pull/507)) @quyansiyuanwang

### 修复 | Fix

- **plugins:** retain main secret draft across strict replay ([#510](https://github.com/TunneldeDev/Tunnelde/pull/510)) @quyansiyuanwang
- **release:** require accepted beta before stable ([#508](https://github.com/TunneldeDev/Tunnelde/pull/508)) @quyansiyuanwang
- **panels:** remove source placeholder after detach ([#511](https://github.com/TunneldeDev/Tunnelde/pull/511)) @quyansiyuanwang
- **plugins:** route native frontend calls through coordinator ([#512](https://github.com/TunneldeDev/Tunnelde/pull/512)) @quyansiyuanwang

</details>

### 贡献者 | Contributors

@quyansiyuanwang

## [2.4.0](https://github.com/TunneldeDev/Tunnelde/compare/v2.3.1...v2.4.0) - 2026-11-21

### 更新概览 | Highlights

- **plugins:** admit declarative views in native windows

<details open>
<summary>详细变更 | Details (1)</summary>

### 新增 | New

- **plugins:** admit declarative views in native windows ([#504](https://github.com/TunneldeDev/Tunnelde/pull/504)) @quyansiyuanwang

</details>

### 贡献者 | Contributors

@quyansiyuanwang

## [2.3.1](https://github.com/TunneldeDev/Tunnelde/compare/v2.3.0...v2.3.1) - 2026-11-21

### 更新概览 | Highlights

- **plugins:** bind declarative views to their execution owner
- **plugins:** retain declarative view owners in the coordinator

<details open>
<summary>详细变更 | Details (2)</summary>

### 改进 | Improved

- **plugins:** bind declarative views to their execution owner ([#501](https://github.com/TunneldeDev/Tunnelde/pull/501)) @quyansiyuanwang
- **plugins:** retain declarative view owners in the coordinator ([#503](https://github.com/TunneldeDev/Tunnelde/pull/503)) @quyansiyuanwang

</details>

### 贡献者 | Contributors

@quyansiyuanwang

## [2.3.0](https://github.com/TunneldeDev/Tunnelde/compare/v2.2.0...v2.3.0) - 2026-11-21

### 更新概览 | Highlights

- 修复原生插件偏好更新在数据库繁忙时长时间持有窗口所有权锁的问题；排队期间释放来源与权限锁，持久提交至内存发布仍保留同一授权边界。Fix native plugin preference updates retaining window ownership while the database is busy; queued attempts release origin and policy locks while durable commit and in-memory publication keep one authorization boundary.

- 已提交的原生插件视图可增删改主机与分组、更新使用时间和排序；复用原业务校验、审计与凭据清理，排队期间取消、撤权或来源失效不会迟到写入。Committed native plugin views can manage hosts/groups, last-used times and ordering through the original validation, audit and credential-cleanup services, rejecting cancelled, revoked or retired callers before queued writes.

- 原生插件独立窗口可保存主机路由和自身扩展字段；提交时复核原窗口、文档、权限、包指纹和 revision，等待数据库期间不占用窗口所有权锁，过期操作不会延迟落盘。Native plugin windows can save host routes and their own metadata fields, with original document/permission/package/revision checks at commit and no ownership lock held across database admission waits.

- 设置页跨窗适配接入完整生产渲染器与主窗操作所有者；草稿保留导航条件，代理密码通过独立私有通道交接，不进入布局或操作任务。已验证 macOS 内置／工厂提供者跨窗草稿往返与主窗确认，其他平台仍待实际验收。Settings window integration uses the complete production renderer and main-owned effects; drafts retain navigation filters and proxy passwords use a separate private channel, not layout or action jobs. Actual macOS builtin/factory-provider draft roundtrips and main-owned consent passed; other platforms still need real acceptance.

- 设置字段提供者容器支持显式展示服务，提供者切换保留同一份字段 DOM 和草稿，不替换或绕过旧式提供者；完整设置跨窗适配仍在继续。Preference provider surfaces accept explicit presentation services while preserving one field DOM/draft and genuine legacy providers; complete native Settings adaptation continues.

- 插件配置、软件源和任务恢复采用显式所有者服务，保留配置草稿原 revision、信任确认及认证生命周期；修复旧软件源编辑残留与失效恢复记录状态。设置独立窗口仍待完整适配。Plugin configuration, sources and recovery use explicit owner services with original draft revisions, trust consent and authentication lifecycles retained; prevent stale source-editor and recovery-record state. Native Settings remains pending.

- 插件安全与 Node 设置拆分读取和操作边界，授权展示不再间接导入启动门禁／剪贴板；安装、取消与确认仍由原主窗所有者执行。Plugin security and Node settings separate display/effects without indirectly importing activation gates or clipboard owners; installation, cancellation and consent stay main-owned.

- 界面提供者、主机挂载贡献者选择及关于页采用共享展示边界，保留主窗启动／指纹校验，折叠与许可证弹窗状态可捕获；设置独立窗口仍待完整适配。Provider selectors and About use shared view boundaries with main-owned activation/fingerprint checks and capture-ready disclosure/license state; native settings remain pending.

- 快捷键编辑器分离展示和所有者操作，录制与高级规则草稿可捕获，失败保存保留编辑，按命令合并避免覆盖其他绑定；设置独立窗口仍待完整适配。Keyboard settings separate presentation from owner effects with capture-ready recorder/advanced drafts, retained failed edits and command-scoped merges; native settings remain pending.

- 存储设置以窄范围所有者命令保留审核、迁移计划与重启确认，目录选择不覆盖其他类别草稿；设置独立窗口仍待完整适配。Storage settings retain review, migration scheduling and restart consent through narrow owner commands, without chooser results replacing unrelated drafts; native settings remain pending.

- 配置方案渲染器支持显式所有者服务及可捕获的命名／导入预览草稿，保留确认前 revision 及确认后读取当前配置的语义；设置独立窗口仍待完整适配。Settings profiles use explicit owner services and capture-ready naming/import-preview drafts while retaining revision and consent semantics; native settings remain pending.

- 网络设置与连接质量诊断使用限定操作接口，路由操作在所有者当前快照上合并，凭据草稿与普通可捕获视图状态分离；设置独立窗口仍待完整适配。Network settings and connection diagnostics use scoped effects and current-owner route merges; credential drafts are separate from ordinary capturable view state. Native settings windows still await full adaptation.

- 设置的主题、文件图标、主机列表默认值、CSS 和更新控件采用可注入的数据／操作接口，数字及更新源输入可保留未完成草稿；不提前开放尚未完整适配的设置独立窗口。Settings theme, file-icon, host-list, CSS and update controls accept explicit data/effects, with capture-ready numeric and update-source drafts; incomplete native settings windows remain unavailable.

- 提取完整设置界面的渲染器与文档内副作用服务，保留原配置方案、专用板块和确认流程；设置独立窗口入口尚未开放。Extract the full settings renderer and document-local effect services while retaining profiles, custom sections and consent; native settings windows are not enabled yet.

- 内置主机详情支持独立窗口往返，保留转发规则与组草稿，主机操作及转发写入按原资源所有权执行；使用旧式主机贡献者或已选转发提供者时暂留主窗。Builtin host details support native-window roundtrips with forwarding rule/group drafts retained and owner-scoped host/forwarding actions; legacy host contributions and selected forwarding providers stay in main for now.

- 本地与 SFTP 文本编辑器支持独立窗体往返，保留未保存文本、主窗撤销历史及选区；编码切换、保存和冲突恢复由原资源所有者执行，修复撤销后焦点丢失及编码菜单键盘输入穿透。Local and SFTP text editors support native-window roundtrips with dirty text, main-owned undo history and selection retained; encoding, saves and conflict recovery use the original owner. Fix undo focus loss and encoding-menu key leakage into the editor.

- 内置在线文件面板支持移入独立窗体并返回，保留目录、筛选和选择；创建、重命名、复制、删除及双向传输使用原 SSH 与受限资源代理，远端选择器、编辑器和插件动作由主窗执行。选中文件浏览界面提供者时暂留主窗。Live builtin file pages support native-window roundtrips with directory/filter/selection retained; creation, rename, copy, deletion and bidirectional transfer reuse SSH through scoped resources, while source selection, editors and plugin actions remain main-owned. Selected file-browser interface providers stay in main for now.

- 内置终端标签支持移入独立窗体和返回，保留原 SSH、屏幕及未完成输入；断开和文件导航由主窗执行。当前选中终端界面插件时保留在主窗，其他页面适配仍在继续。Builtin terminal tabs support native-window roundtrips with the original SSH, screen and partial input retained; disconnect/navigation remain main-owned. Selected terminal interface providers stay in main for now; other page adapters remain in progress.

- 终端渲染器支持只读设置与限定作用域的连接服务，普通检查点不会被误当成迁移交接；远程 shell 在暂离期间退出时，为交接保留最后输出。Terminal rendering supports read-only preferences and scoped I/O; periodic checkpoints are distinct from move barriers, and detached shell exit retains final output for handoff. The native terminal page entry remains pending.

- 原生终端流具备按窗口/文档/面板代次校验的私有端点，交接保留原 SSH 与序列回放；为后续终端页面跨窗接入提供基础，暂未开放该页面入口。Private native terminal endpoints enforce window/document/panel generations and retain the original SSH stream with sequence replay; terminal page window integration remains pending.

- 终端交接按会话隔离并支持失败恢复，后台恢复不会抢占正在迁移的终端；保留字符集、键盘协议和分包状态的 JSON 快照为终端跨窗接入提供基础。Terminal handoff reserves individual sessions with rollback/retry; background resume cannot steal a pending handoff, and lossless JSON checkpoints prepare the terminal window adapter.

- 原生插件视图可读取已保存主机、发现来源、路由及自身扩展字段的元数据快照；暂存期间仍禁止导入、修改、凭据访问和建立连接。Native plugin views can read saved-host, discovery-source, route and own-field metadata snapshots; staging still forbids host mutations, imports, credentials and connection creation.

- 插件列表支持独立窗体与返回，保留搜索、筛选及分页；详情、安装确认和本地安装草稿由主窗持有，安装操作重新校验目录条目而不接收独立窗提交的下载地址。Plugin lists support native-window roundtrips with search/filter/page state; details, installation confirmation and local-install drafts remain main-owned, with catalogue targets revalidated instead of accepting satellite-supplied download URLs.

- 主机列表可移入独立窗体并返回，保留搜索、折叠与兼容插件草稿；收藏、视图设置等操作回到主协调器执行，凭据及导入导出对话框仍由主窗持有。Host lists support native-window roundtrips with search, collapsed groups and compatible provider drafts preserved; actions execute through the main coordinator, while credential/import/export dialogs remain main-owned.

- 停靠的文件预览支持移入独立窗体并返回，保留受支持的插件草稿、PDF 页码/缩放和媒体位置，复用原文件资源；修复元数据更新抢夺文本焦点及异步正文就绪被错误取消。Docked file previews support explicit native-window roundtrips with supported provider drafts, PDF page/zoom and media position preserved on the original resource; fix metadata-driven text focus resets and retired async readiness cancelling replacement renderers.

- 预览元数据与读取状态由宿主独立持有，正文暂时移除不会使插件观察丢失；补齐文本、PDF 和媒体的视图状态捕获，为完整跨窗口预览继续铺设基础。Preview metadata/read state survives an absent renderer; text, PDF and media state capture prepares the remaining native preview adapter.

- 文件预览资源由独立宿主持有，移除正文不会重新读取远程文件或关闭媒体票据；增加绑定文档与面板实例的只读窗口句柄，为后续预览跨窗适配提供基础。Preview reads outlive renderer bodies; private document/panel-scoped read handles prepare native preview handoff without reopening remote files or exposing the underlying ticket.

- 独立窗口中的插件支持创建一次性 SSHFS 挂载；启动失败或结果丢失会清理自身进程和通道，不断开借用的 SSH 会话。Plugins in native panel windows can create one-off SSHFS mounts, with owned startup cleanup that preserves the borrowed SSH session.
- 后台任务插件界面支持独立窗口迁移，保留草稿和任务状态，操作受权限保护且不会重复启动插件。Background-task interface providers support native window handoff with preserved drafts/task state and permission-checked actions, without replaying plugin activation.

- 面板独立窗口预览：连接、后台任务、输出、已知主机和端口转发面板，以及兼容的侧栏插件视图可在窗口间移动；迁移保留受支持的视图状态。其他页面及无工厂旧插件视图的跨窗口适配仍在进行。Native panel-window preview supports connections, background tasks, output, known hosts, forwarding and compatible sidebar plugin views with supported view-state transfer; other pages and legacy factoryless views remain in progress.
- 改进挂载目录浏览、状态读取、打开和卸载，复用原 SSH 连接并在取消操作后完成资源清理。Improve mount browsing, snapshots, opening and teardown while reusing the original SSH connection and completing resource cleanup after cancellation.

- 存储位置支持逐项或批量恢复默认，并在迁移前展示计划、保护已有数据。Storage locations can reset individually or in batches with a reviewed migration plan and existing-data protection.
- 插件可直接格式化当前编辑器文件，支持可配置快捷键、撤销重做和异步修改冲突保护。Plugins can format the active editor with configurable shortcuts, undo/redo and protection against stale asynchronous edits.
- 更新说明可展开查看当前版本至目标版本的累计变更；历史不完整或加载失败时会明确提示并允许重试。Update notes include changes from the installed version through the selected target, with clear incomplete-history notices and retry.
- 测试连接显示沿实际代理与跳板路径的三次 SSH 建立耗时、波动和成功次数，支持取消与重测。Connection tests show three SSH establishment measurements through the configured route, their spread and success count, with cancel and retry.

<details open>
<summary>详细变更 | Details (2)</summary>

### 新增 | New

- **plugins:** admit native host and group management ([#498](https://github.com/TunneldeDev/Tunnelde/pull/498)) @quyansiyuanwang

### 修复 | Fix

- **plugins:** release native preference locks during database waits ([#500](https://github.com/TunneldeDev/Tunnelde/pull/500)) @quyansiyuanwang

</details>

### 贡献者 | Contributors

@quyansiyuanwang

## [2.2.0](https://github.com/TunneldeDev/Tunnelde/compare/v2.1.0...v2.2.0) - 2026-11-21

### 更新概览 | Highlights

- 原生插件独立窗口可保存主机路由和自身扩展字段；提交时复核原窗口、文档、权限、包指纹和 revision，等待数据库期间不占用窗口所有权锁，过期操作不会延迟落盘。Native plugin windows can save host routes and their own metadata fields, with original document/permission/package/revision checks at commit and no ownership lock held across database admission waits.

- 设置页跨窗适配接入完整生产渲染器与主窗操作所有者；草稿保留导航条件，代理密码通过独立私有通道交接，不进入布局或操作任务。已验证 macOS 内置／工厂提供者跨窗草稿往返与主窗确认，其他平台仍待实际验收。Settings window integration uses the complete production renderer and main-owned effects; drafts retain navigation filters and proxy passwords use a separate private channel, not layout or action jobs. Actual macOS builtin/factory-provider draft roundtrips and main-owned consent passed; other platforms still need real acceptance.

- 设置字段提供者容器支持显式展示服务，提供者切换保留同一份字段 DOM 和草稿，不替换或绕过旧式提供者；完整设置跨窗适配仍在继续。Preference provider surfaces accept explicit presentation services while preserving one field DOM/draft and genuine legacy providers; complete native Settings adaptation continues.

- 插件配置、软件源和任务恢复采用显式所有者服务，保留配置草稿原 revision、信任确认及认证生命周期；修复旧软件源编辑残留与失效恢复记录状态。设置独立窗口仍待完整适配。Plugin configuration, sources and recovery use explicit owner services with original draft revisions, trust consent and authentication lifecycles retained; prevent stale source-editor and recovery-record state. Native Settings remains pending.

- 插件安全与 Node 设置拆分读取和操作边界，授权展示不再间接导入启动门禁／剪贴板；安装、取消与确认仍由原主窗所有者执行。Plugin security and Node settings separate display/effects without indirectly importing activation gates or clipboard owners; installation, cancellation and consent stay main-owned.

- 界面提供者、主机挂载贡献者选择及关于页采用共享展示边界，保留主窗启动／指纹校验，折叠与许可证弹窗状态可捕获；设置独立窗口仍待完整适配。Provider selectors and About use shared view boundaries with main-owned activation/fingerprint checks and capture-ready disclosure/license state; native settings remain pending.

- 快捷键编辑器分离展示和所有者操作，录制与高级规则草稿可捕获，失败保存保留编辑，按命令合并避免覆盖其他绑定；设置独立窗口仍待完整适配。Keyboard settings separate presentation from owner effects with capture-ready recorder/advanced drafts, retained failed edits and command-scoped merges; native settings remain pending.

- 存储设置以窄范围所有者命令保留审核、迁移计划与重启确认，目录选择不覆盖其他类别草稿；设置独立窗口仍待完整适配。Storage settings retain review, migration scheduling and restart consent through narrow owner commands, without chooser results replacing unrelated drafts; native settings remain pending.

- 配置方案渲染器支持显式所有者服务及可捕获的命名／导入预览草稿，保留确认前 revision 及确认后读取当前配置的语义；设置独立窗口仍待完整适配。Settings profiles use explicit owner services and capture-ready naming/import-preview drafts while retaining revision and consent semantics; native settings remain pending.

- 网络设置与连接质量诊断使用限定操作接口，路由操作在所有者当前快照上合并，凭据草稿与普通可捕获视图状态分离；设置独立窗口仍待完整适配。Network settings and connection diagnostics use scoped effects and current-owner route merges; credential drafts are separate from ordinary capturable view state. Native settings windows still await full adaptation.

- 设置的主题、文件图标、主机列表默认值、CSS 和更新控件采用可注入的数据／操作接口，数字及更新源输入可保留未完成草稿；不提前开放尚未完整适配的设置独立窗口。Settings theme, file-icon, host-list, CSS and update controls accept explicit data/effects, with capture-ready numeric and update-source drafts; incomplete native settings windows remain unavailable.

- 提取完整设置界面的渲染器与文档内副作用服务，保留原配置方案、专用板块和确认流程；设置独立窗口入口尚未开放。Extract the full settings renderer and document-local effect services while retaining profiles, custom sections and consent; native settings windows are not enabled yet.

- 内置主机详情支持独立窗口往返，保留转发规则与组草稿，主机操作及转发写入按原资源所有权执行；使用旧式主机贡献者或已选转发提供者时暂留主窗。Builtin host details support native-window roundtrips with forwarding rule/group drafts retained and owner-scoped host/forwarding actions; legacy host contributions and selected forwarding providers stay in main for now.

- 本地与 SFTP 文本编辑器支持独立窗体往返，保留未保存文本、主窗撤销历史及选区；编码切换、保存和冲突恢复由原资源所有者执行，修复撤销后焦点丢失及编码菜单键盘输入穿透。Local and SFTP text editors support native-window roundtrips with dirty text, main-owned undo history and selection retained; encoding, saves and conflict recovery use the original owner. Fix undo focus loss and encoding-menu key leakage into the editor.

- 内置在线文件面板支持移入独立窗体并返回，保留目录、筛选和选择；创建、重命名、复制、删除及双向传输使用原 SSH 与受限资源代理，远端选择器、编辑器和插件动作由主窗执行。选中文件浏览界面提供者时暂留主窗。Live builtin file pages support native-window roundtrips with directory/filter/selection retained; creation, rename, copy, deletion and bidirectional transfer reuse SSH through scoped resources, while source selection, editors and plugin actions remain main-owned. Selected file-browser interface providers stay in main for now.

- 内置终端标签支持移入独立窗体和返回，保留原 SSH、屏幕及未完成输入；断开和文件导航由主窗执行。当前选中终端界面插件时保留在主窗，其他页面适配仍在继续。Builtin terminal tabs support native-window roundtrips with the original SSH, screen and partial input retained; disconnect/navigation remain main-owned. Selected terminal interface providers stay in main for now; other page adapters remain in progress.

- 终端渲染器支持只读设置与限定作用域的连接服务，普通检查点不会被误当成迁移交接；远程 shell 在暂离期间退出时，为交接保留最后输出。Terminal rendering supports read-only preferences and scoped I/O; periodic checkpoints are distinct from move barriers, and detached shell exit retains final output for handoff. The native terminal page entry remains pending.

- 原生终端流具备按窗口/文档/面板代次校验的私有端点，交接保留原 SSH 与序列回放；为后续终端页面跨窗接入提供基础，暂未开放该页面入口。Private native terminal endpoints enforce window/document/panel generations and retain the original SSH stream with sequence replay; terminal page window integration remains pending.

- 终端交接按会话隔离并支持失败恢复，后台恢复不会抢占正在迁移的终端；保留字符集、键盘协议和分包状态的 JSON 快照为终端跨窗接入提供基础。Terminal handoff reserves individual sessions with rollback/retry; background resume cannot steal a pending handoff, and lossless JSON checkpoints prepare the terminal window adapter.

- 原生插件视图可读取已保存主机、发现来源、路由及自身扩展字段的元数据快照；暂存期间仍禁止导入、修改、凭据访问和建立连接。Native plugin views can read saved-host, discovery-source, route and own-field metadata snapshots; staging still forbids host mutations, imports, credentials and connection creation.

- 插件列表支持独立窗体与返回，保留搜索、筛选及分页；详情、安装确认和本地安装草稿由主窗持有，安装操作重新校验目录条目而不接收独立窗提交的下载地址。Plugin lists support native-window roundtrips with search/filter/page state; details, installation confirmation and local-install drafts remain main-owned, with catalogue targets revalidated instead of accepting satellite-supplied download URLs.

- 主机列表可移入独立窗体并返回，保留搜索、折叠与兼容插件草稿；收藏、视图设置等操作回到主协调器执行，凭据及导入导出对话框仍由主窗持有。Host lists support native-window roundtrips with search, collapsed groups and compatible provider drafts preserved; actions execute through the main coordinator, while credential/import/export dialogs remain main-owned.

- 停靠的文件预览支持移入独立窗体并返回，保留受支持的插件草稿、PDF 页码/缩放和媒体位置，复用原文件资源；修复元数据更新抢夺文本焦点及异步正文就绪被错误取消。Docked file previews support explicit native-window roundtrips with supported provider drafts, PDF page/zoom and media position preserved on the original resource; fix metadata-driven text focus resets and retired async readiness cancelling replacement renderers.

- 预览元数据与读取状态由宿主独立持有，正文暂时移除不会使插件观察丢失；补齐文本、PDF 和媒体的视图状态捕获，为完整跨窗口预览继续铺设基础。Preview metadata/read state survives an absent renderer; text, PDF and media state capture prepares the remaining native preview adapter.

- 文件预览资源由独立宿主持有，移除正文不会重新读取远程文件或关闭媒体票据；增加绑定文档与面板实例的只读窗口句柄，为后续预览跨窗适配提供基础。Preview reads outlive renderer bodies; private document/panel-scoped read handles prepare native preview handoff without reopening remote files or exposing the underlying ticket.

- 独立窗口中的插件支持创建一次性 SSHFS 挂载；启动失败或结果丢失会清理自身进程和通道，不断开借用的 SSH 会话。Plugins in native panel windows can create one-off SSHFS mounts, with owned startup cleanup that preserves the borrowed SSH session.
- 后台任务插件界面支持独立窗口迁移，保留草稿和任务状态，操作受权限保护且不会重复启动插件。Background-task interface providers support native window handoff with preserved drafts/task state and permission-checked actions, without replaying plugin activation.

- 面板独立窗口预览：连接、后台任务、输出、已知主机和端口转发面板，以及兼容的侧栏插件视图可在窗口间移动；迁移保留受支持的视图状态。其他页面及无工厂旧插件视图的跨窗口适配仍在进行。Native panel-window preview supports connections, background tasks, output, known hosts, forwarding and compatible sidebar plugin views with supported view-state transfer; other pages and legacy factoryless views remain in progress.
- 改进挂载目录浏览、状态读取、打开和卸载，复用原 SSH 连接并在取消操作后完成资源清理。Improve mount browsing, snapshots, opening and teardown while reusing the original SSH connection and completing resource cleanup after cancellation.

- 存储位置支持逐项或批量恢复默认，并在迁移前展示计划、保护已有数据。Storage locations can reset individually or in batches with a reviewed migration plan and existing-data protection.
- 插件可直接格式化当前编辑器文件，支持可配置快捷键、撤销重做和异步修改冲突保护。Plugins can format the active editor with configurable shortcuts, undo/redo and protection against stale asynchronous edits.
- 更新说明可展开查看当前版本至目标版本的累计变更；历史不完整或加载失败时会明确提示并允许重试。Update notes include changes from the installed version through the selected target, with clear incomplete-history notices and retry.
- 测试连接显示沿实际代理与跳板路径的三次 SSH 建立耗时、波动和成功次数，支持取消与重测。Connection tests show three SSH establishment measurements through the configured route, their spread and success count, with cancel and retry.

<details open>
<summary>详细变更 | Details (1)</summary>

### 新增 | New

- **plugins:** support origin-fenced native host metadata writes ([#496](https://github.com/TunneldeDev/Tunnelde/pull/496)) @quyansiyuanwang

</details>

### 贡献者 | Contributors

@quyansiyuanwang

## [2.1.0](https://github.com/TunneldeDev/Tunnelde/compare/v2.0.0...v2.1.0) - 2026-11-21

### 更新概览 | Highlights

- 设置页跨窗适配接入完整生产渲染器与主窗操作所有者；草稿保留导航条件，代理密码通过独立私有通道交接，不进入布局或操作任务。已验证 macOS 内置／工厂提供者跨窗草稿往返与主窗确认，其他平台仍待实际验收。Settings window integration uses the complete production renderer and main-owned effects; drafts retain navigation filters and proxy passwords use a separate private channel, not layout or action jobs. Actual macOS builtin/factory-provider draft roundtrips and main-owned consent passed; other platforms still need real acceptance.

- 设置字段提供者容器支持显式展示服务，提供者切换保留同一份字段 DOM 和草稿，不替换或绕过旧式提供者；完整设置跨窗适配仍在继续。Preference provider surfaces accept explicit presentation services while preserving one field DOM/draft and genuine legacy providers; complete native Settings adaptation continues.

- 插件配置、软件源和任务恢复采用显式所有者服务，保留配置草稿原 revision、信任确认及认证生命周期；修复旧软件源编辑残留与失效恢复记录状态。设置独立窗口仍待完整适配。Plugin configuration, sources and recovery use explicit owner services with original draft revisions, trust consent and authentication lifecycles retained; prevent stale source-editor and recovery-record state. Native Settings remains pending.

- 插件安全与 Node 设置拆分读取和操作边界，授权展示不再间接导入启动门禁／剪贴板；安装、取消与确认仍由原主窗所有者执行。Plugin security and Node settings separate display/effects without indirectly importing activation gates or clipboard owners; installation, cancellation and consent stay main-owned.

- 界面提供者、主机挂载贡献者选择及关于页采用共享展示边界，保留主窗启动／指纹校验，折叠与许可证弹窗状态可捕获；设置独立窗口仍待完整适配。Provider selectors and About use shared view boundaries with main-owned activation/fingerprint checks and capture-ready disclosure/license state; native settings remain pending.

- 快捷键编辑器分离展示和所有者操作，录制与高级规则草稿可捕获，失败保存保留编辑，按命令合并避免覆盖其他绑定；设置独立窗口仍待完整适配。Keyboard settings separate presentation from owner effects with capture-ready recorder/advanced drafts, retained failed edits and command-scoped merges; native settings remain pending.

- 存储设置以窄范围所有者命令保留审核、迁移计划与重启确认，目录选择不覆盖其他类别草稿；设置独立窗口仍待完整适配。Storage settings retain review, migration scheduling and restart consent through narrow owner commands, without chooser results replacing unrelated drafts; native settings remain pending.

- 配置方案渲染器支持显式所有者服务及可捕获的命名／导入预览草稿，保留确认前 revision 及确认后读取当前配置的语义；设置独立窗口仍待完整适配。Settings profiles use explicit owner services and capture-ready naming/import-preview drafts while retaining revision and consent semantics; native settings remain pending.

- 网络设置与连接质量诊断使用限定操作接口，路由操作在所有者当前快照上合并，凭据草稿与普通可捕获视图状态分离；设置独立窗口仍待完整适配。Network settings and connection diagnostics use scoped effects and current-owner route merges; credential drafts are separate from ordinary capturable view state. Native settings windows still await full adaptation.

- 设置的主题、文件图标、主机列表默认值、CSS 和更新控件采用可注入的数据／操作接口，数字及更新源输入可保留未完成草稿；不提前开放尚未完整适配的设置独立窗口。Settings theme, file-icon, host-list, CSS and update controls accept explicit data/effects, with capture-ready numeric and update-source drafts; incomplete native settings windows remain unavailable.

- 提取完整设置界面的渲染器与文档内副作用服务，保留原配置方案、专用板块和确认流程；设置独立窗口入口尚未开放。Extract the full settings renderer and document-local effect services while retaining profiles, custom sections and consent; native settings windows are not enabled yet.

- 内置主机详情支持独立窗口往返，保留转发规则与组草稿，主机操作及转发写入按原资源所有权执行；使用旧式主机贡献者或已选转发提供者时暂留主窗。Builtin host details support native-window roundtrips with forwarding rule/group drafts retained and owner-scoped host/forwarding actions; legacy host contributions and selected forwarding providers stay in main for now.

- 本地与 SFTP 文本编辑器支持独立窗体往返，保留未保存文本、主窗撤销历史及选区；编码切换、保存和冲突恢复由原资源所有者执行，修复撤销后焦点丢失及编码菜单键盘输入穿透。Local and SFTP text editors support native-window roundtrips with dirty text, main-owned undo history and selection retained; encoding, saves and conflict recovery use the original owner. Fix undo focus loss and encoding-menu key leakage into the editor.

- 内置在线文件面板支持移入独立窗体并返回，保留目录、筛选和选择；创建、重命名、复制、删除及双向传输使用原 SSH 与受限资源代理，远端选择器、编辑器和插件动作由主窗执行。选中文件浏览界面提供者时暂留主窗。Live builtin file pages support native-window roundtrips with directory/filter/selection retained; creation, rename, copy, deletion and bidirectional transfer reuse SSH through scoped resources, while source selection, editors and plugin actions remain main-owned. Selected file-browser interface providers stay in main for now.

- 内置终端标签支持移入独立窗体和返回，保留原 SSH、屏幕及未完成输入；断开和文件导航由主窗执行。当前选中终端界面插件时保留在主窗，其他页面适配仍在继续。Builtin terminal tabs support native-window roundtrips with the original SSH, screen and partial input retained; disconnect/navigation remain main-owned. Selected terminal interface providers stay in main for now; other page adapters remain in progress.

- 终端渲染器支持只读设置与限定作用域的连接服务，普通检查点不会被误当成迁移交接；远程 shell 在暂离期间退出时，为交接保留最后输出。Terminal rendering supports read-only preferences and scoped I/O; periodic checkpoints are distinct from move barriers, and detached shell exit retains final output for handoff. The native terminal page entry remains pending.

- 原生终端流具备按窗口/文档/面板代次校验的私有端点，交接保留原 SSH 与序列回放；为后续终端页面跨窗接入提供基础，暂未开放该页面入口。Private native terminal endpoints enforce window/document/panel generations and retain the original SSH stream with sequence replay; terminal page window integration remains pending.

- 终端交接按会话隔离并支持失败恢复，后台恢复不会抢占正在迁移的终端；保留字符集、键盘协议和分包状态的 JSON 快照为终端跨窗接入提供基础。Terminal handoff reserves individual sessions with rollback/retry; background resume cannot steal a pending handoff, and lossless JSON checkpoints prepare the terminal window adapter.

- 原生插件视图可读取已保存主机、发现来源、路由及自身扩展字段的元数据快照；暂存期间仍禁止导入、修改、凭据访问和建立连接。Native plugin views can read saved-host, discovery-source, route and own-field metadata snapshots; staging still forbids host mutations, imports, credentials and connection creation.

- 插件列表支持独立窗体与返回，保留搜索、筛选及分页；详情、安装确认和本地安装草稿由主窗持有，安装操作重新校验目录条目而不接收独立窗提交的下载地址。Plugin lists support native-window roundtrips with search/filter/page state; details, installation confirmation and local-install drafts remain main-owned, with catalogue targets revalidated instead of accepting satellite-supplied download URLs.

- 主机列表可移入独立窗体并返回，保留搜索、折叠与兼容插件草稿；收藏、视图设置等操作回到主协调器执行，凭据及导入导出对话框仍由主窗持有。Host lists support native-window roundtrips with search, collapsed groups and compatible provider drafts preserved; actions execute through the main coordinator, while credential/import/export dialogs remain main-owned.

- 停靠的文件预览支持移入独立窗体并返回，保留受支持的插件草稿、PDF 页码/缩放和媒体位置，复用原文件资源；修复元数据更新抢夺文本焦点及异步正文就绪被错误取消。Docked file previews support explicit native-window roundtrips with supported provider drafts, PDF page/zoom and media position preserved on the original resource; fix metadata-driven text focus resets and retired async readiness cancelling replacement renderers.

- 预览元数据与读取状态由宿主独立持有，正文暂时移除不会使插件观察丢失；补齐文本、PDF 和媒体的视图状态捕获，为完整跨窗口预览继续铺设基础。Preview metadata/read state survives an absent renderer; text, PDF and media state capture prepares the remaining native preview adapter.

- 文件预览资源由独立宿主持有，移除正文不会重新读取远程文件或关闭媒体票据；增加绑定文档与面板实例的只读窗口句柄，为后续预览跨窗适配提供基础。Preview reads outlive renderer bodies; private document/panel-scoped read handles prepare native preview handoff without reopening remote files or exposing the underlying ticket.

- 独立窗口中的插件支持创建一次性 SSHFS 挂载；启动失败或结果丢失会清理自身进程和通道，不断开借用的 SSH 会话。Plugins in native panel windows can create one-off SSHFS mounts, with owned startup cleanup that preserves the borrowed SSH session.
- 后台任务插件界面支持独立窗口迁移，保留草稿和任务状态，操作受权限保护且不会重复启动插件。Background-task interface providers support native window handoff with preserved drafts/task state and permission-checked actions, without replaying plugin activation.

- 面板独立窗口预览：连接、后台任务、输出、已知主机和端口转发面板，以及兼容的侧栏插件视图可在窗口间移动；迁移保留受支持的视图状态。其他页面及无工厂旧插件视图的跨窗口适配仍在进行。Native panel-window preview supports connections, background tasks, output, known hosts, forwarding and compatible sidebar plugin views with supported view-state transfer; other pages and legacy factoryless views remain in progress.
- 改进挂载目录浏览、状态读取、打开和卸载，复用原 SSH 连接并在取消操作后完成资源清理。Improve mount browsing, snapshots, opening and teardown while reusing the original SSH connection and completing resource cleanup after cancellation.

- 存储位置支持逐项或批量恢复默认，并在迁移前展示计划、保护已有数据。Storage locations can reset individually or in batches with a reviewed migration plan and existing-data protection.
- 插件可直接格式化当前编辑器文件，支持可配置快捷键、撤销重做和异步修改冲突保护。Plugins can format the active editor with configurable shortcuts, undo/redo and protection against stale asynchronous edits.
- 更新说明可展开查看当前版本至目标版本的累计变更；历史不完整或加载失败时会明确提示并允许重试。Update notes include changes from the installed version through the selected target, with clear incomplete-history notices and retry.
- 测试连接显示沿实际代理与跳板路径的三次 SSH 建立耗时、波动和成功次数，支持取消与重测。Connection tests show three SSH establishment measurements through the configured route, their spread and success count, with cancel and retry.

<details open>
<summary>详细变更 | Details (7)</summary>

### 新增 | New

- **settings:** support complete native window presentation ([#495](https://github.com/TunneldeDev/Tunnelde/pull/495)) @quyansiyuanwang

### 改进 | Improved

- **settings:** isolate production renderer effects ([#488](https://github.com/TunneldeDev/Tunnelde/pull/488)) @quyansiyuanwang
- **settings:** separate specialized controls from owners ([#490](https://github.com/TunneldeDev/Tunnelde/pull/490)) @quyansiyuanwang
- **settings:** isolate network profile and storage services ([#491](https://github.com/TunneldeDev/Tunnelde/pull/491)) @quyansiyuanwang
- **settings:** isolate keyboard and plugin control services ([#492](https://github.com/TunneldeDev/Tunnelde/pull/492)) @quyansiyuanwang
- **settings:** isolate plugin configuration source and recovery views ([#493](https://github.com/TunneldeDev/Tunnelde/pull/493)) @quyansiyuanwang
- **settings:** isolate preference provider surface services ([#494](https://github.com/TunneldeDev/Tunnelde/pull/494)) @quyansiyuanwang

</details>

### 贡献者 | Contributors

@quyansiyuanwang

## [2.0.0](https://github.com/TunneldeDev/Tunnelde/compare/v1.4.4...v2.0.0) - 2026-11-21

### 更新概览 | Highlights

- 内置主机详情支持独立窗口往返，保留转发规则与组草稿，主机操作及转发写入按原资源所有权执行；使用旧式主机贡献者或已选转发提供者时暂留主窗。Builtin host details support native-window roundtrips with forwarding rule/group drafts retained and owner-scoped host/forwarding actions; legacy host contributions and selected forwarding providers stay in main for now.

- 本地与 SFTP 文本编辑器支持独立窗体往返，保留未保存文本、主窗撤销历史及选区；编码切换、保存和冲突恢复由原资源所有者执行，修复撤销后焦点丢失及编码菜单键盘输入穿透。Local and SFTP text editors support native-window roundtrips with dirty text, main-owned undo history and selection retained; encoding, saves and conflict recovery use the original owner. Fix undo focus loss and encoding-menu key leakage into the editor.

- 内置在线文件面板支持移入独立窗体并返回，保留目录、筛选和选择；创建、重命名、复制、删除及双向传输使用原 SSH 与受限资源代理，远端选择器、编辑器和插件动作由主窗执行。选中文件浏览界面提供者时暂留主窗。Live builtin file pages support native-window roundtrips with directory/filter/selection retained; creation, rename, copy, deletion and bidirectional transfer reuse SSH through scoped resources, while source selection, editors and plugin actions remain main-owned. Selected file-browser interface providers stay in main for now.

- 内置终端标签支持移入独立窗体和返回，保留原 SSH、屏幕及未完成输入；断开和文件导航由主窗执行。当前选中终端界面插件时保留在主窗，其他页面适配仍在继续。Builtin terminal tabs support native-window roundtrips with the original SSH, screen and partial input retained; disconnect/navigation remain main-owned. Selected terminal interface providers stay in main for now; other page adapters remain in progress.

- 终端渲染器支持只读设置与限定作用域的连接服务，普通检查点不会被误当成迁移交接；远程 shell 在暂离期间退出时，为交接保留最后输出。Terminal rendering supports read-only preferences and scoped I/O; periodic checkpoints are distinct from move barriers, and detached shell exit retains final output for handoff. The native terminal page entry remains pending.

- 原生终端流具备按窗口/文档/面板代次校验的私有端点，交接保留原 SSH 与序列回放；为后续终端页面跨窗接入提供基础，暂未开放该页面入口。Private native terminal endpoints enforce window/document/panel generations and retain the original SSH stream with sequence replay; terminal page window integration remains pending.

- 终端交接按会话隔离并支持失败恢复，后台恢复不会抢占正在迁移的终端；保留字符集、键盘协议和分包状态的 JSON 快照为终端跨窗接入提供基础。Terminal handoff reserves individual sessions with rollback/retry; background resume cannot steal a pending handoff, and lossless JSON checkpoints prepare the terminal window adapter.

- 原生插件视图可读取已保存主机、发现来源、路由及自身扩展字段的元数据快照；暂存期间仍禁止导入、修改、凭据访问和建立连接。Native plugin views can read saved-host, discovery-source, route and own-field metadata snapshots; staging still forbids host mutations, imports, credentials and connection creation.

- 插件列表支持独立窗体与返回，保留搜索、筛选及分页；详情、安装确认和本地安装草稿由主窗持有，安装操作重新校验目录条目而不接收独立窗提交的下载地址。Plugin lists support native-window roundtrips with search/filter/page state; details, installation confirmation and local-install drafts remain main-owned, with catalogue targets revalidated instead of accepting satellite-supplied download URLs.

- 主机列表可移入独立窗体并返回，保留搜索、折叠与兼容插件草稿；收藏、视图设置等操作回到主协调器执行，凭据及导入导出对话框仍由主窗持有。Host lists support native-window roundtrips with search, collapsed groups and compatible provider drafts preserved; actions execute through the main coordinator, while credential/import/export dialogs remain main-owned.

- 停靠的文件预览支持移入独立窗体并返回，保留受支持的插件草稿、PDF 页码/缩放和媒体位置，复用原文件资源；修复元数据更新抢夺文本焦点及异步正文就绪被错误取消。Docked file previews support explicit native-window roundtrips with supported provider drafts, PDF page/zoom and media position preserved on the original resource; fix metadata-driven text focus resets and retired async readiness cancelling replacement renderers.

- 预览元数据与读取状态由宿主独立持有，正文暂时移除不会使插件观察丢失；补齐文本、PDF 和媒体的视图状态捕获，为完整跨窗口预览继续铺设基础。Preview metadata/read state survives an absent renderer; text, PDF and media state capture prepares the remaining native preview adapter.

- 文件预览资源由独立宿主持有，移除正文不会重新读取远程文件或关闭媒体票据；增加绑定文档与面板实例的只读窗口句柄，为后续预览跨窗适配提供基础。Preview reads outlive renderer bodies; private document/panel-scoped read handles prepare native preview handoff without reopening remote files or exposing the underlying ticket.

- 独立窗口中的插件支持创建一次性 SSHFS 挂载；启动失败或结果丢失会清理自身进程和通道，不断开借用的 SSH 会话。Plugins in native panel windows can create one-off SSHFS mounts, with owned startup cleanup that preserves the borrowed SSH session.
- 后台任务插件界面支持独立窗口迁移，保留草稿和任务状态，操作受权限保护且不会重复启动插件。Background-task interface providers support native window handoff with preserved drafts/task state and permission-checked actions, without replaying plugin activation.

- 面板独立窗口预览：连接、后台任务、输出、已知主机和端口转发面板，以及兼容的侧栏插件视图可在窗口间移动；迁移保留受支持的视图状态。其他页面及无工厂旧插件视图的跨窗口适配仍在进行。Native panel-window preview supports connections, background tasks, output, known hosts, forwarding and compatible sidebar plugin views with supported view-state transfer; other pages and legacy factoryless views remain in progress.
- 改进挂载目录浏览、状态读取、打开和卸载，复用原 SSH 连接并在取消操作后完成资源清理。Improve mount browsing, snapshots, opening and teardown while reusing the original SSH connection and completing resource cleanup after cancellation.

- 存储位置支持逐项或批量恢复默认，并在迁移前展示计划、保护已有数据。Storage locations can reset individually or in batches with a reviewed migration plan and existing-data protection.
- 插件可直接格式化当前编辑器文件，支持可配置快捷键、撤销重做和异步修改冲突保护。Plugins can format the active editor with configurable shortcuts, undo/redo and protection against stale asynchronous edits.
- 更新说明可展开查看当前版本至目标版本的累计变更；历史不完整或加载失败时会明确提示并允许重试。Update notes include changes from the installed version through the selected target, with clear incomplete-history notices and retry.
- 测试连接显示沿实际代理与跳板路径的三次 SSH 建立耗时、波动和成功次数，支持取消与重测。Connection tests show three SSH establishment measurements through the configured route, their spread and success count, with cancel and retry.

<details open>
<summary>详细变更 | Details (60)</summary>

### 不兼容变更 | Breaking changes

- **hosts:** add host migration and isolated forwarding groups ([#452](https://github.com/TunneldeDev/Tunnelde/pull/452)) @quyansiyuanwang

### 新增 | New

- **files:** add plugin file-list highlights ([#425](https://github.com/TunneldeDev/Tunnelde/pull/425)) @quyansiyuanwang
- **editor:** support common text encodings ([#426](https://github.com/TunneldeDev/Tunnelde/pull/426)) @quyansiyuanwang
- **editor:** add plugin syntax highlighting ([#432](https://github.com/TunneldeDev/Tunnelde/pull/432)) @quyansiyuanwang
- **editor:** add unified virtualized code editor ([#435](https://github.com/TunneldeDev/Tunnelde/pull/435)) @quyansiyuanwang
- **ssh:** import local SSH config from the welcome page ([#439](https://github.com/TunneldeDev/Tunnelde/pull/439)) @quyansiyuanwang
- **forwarding:** automate saved rules and show connection sessions ([#443](https://github.com/TunneldeDev/Tunnelde/pull/443)) @quyansiyuanwang
- **plugins:** expose interactive host details and forwarding automation ([#444](https://github.com/TunneldeDev/Tunnelde/pull/444)) @quyansiyuanwang
- **mounts:** expose shared persistent mount rules and group runtime ([#445](https://github.com/TunneldeDev/Tunnelde/pull/445)) @quyansiyuanwang
- **plugins:** expose native OpenSSH config import ([#446](https://github.com/TunneldeDev/Tunnelde/pull/446)) @quyansiyuanwang
- **plugins:** expose revisioned saved host routes ([#447](https://github.com/TunneldeDev/Tunnelde/pull/447)) @quyansiyuanwang
- **plugins:** start forwarding rules in bounded batches ([#448](https://github.com/TunneldeDev/Tunnelde/pull/448)) @quyansiyuanwang
- **mounts:** render shared mount management for plugins ([#451](https://github.com/TunneldeDev/Tunnelde/pull/451)) @quyansiyuanwang
- **plugins:** add scoped plugin message buses ([#450](https://github.com/TunneldeDev/Tunnelde/pull/450)) @quyansiyuanwang
- **plugins:** reconcile private bus membership and invitations ([#454](https://github.com/TunneldeDev/Tunnelde/pull/454)) @quyansiyuanwang
- **hosts:** add encrypted credential and private-key migration ([#459](https://github.com/TunneldeDev/Tunnelde/pull/459)) @quyansiyuanwang
- **ui:** unify compact dialog help and password actions ([#461](https://github.com/TunneldeDev/Tunnelde/pull/461)) @quyansiyuanwang
- **workbench:** unify panel and floating presentations ([#462](https://github.com/TunneldeDev/Tunnelde/pull/462)) @quyansiyuanwang
- **layout:** resize split intersections atomically ([#463](https://github.com/TunneldeDev/Tunnelde/pull/463)) @quyansiyuanwang
- **workbench:** float built-in pages and manage session lifetimes ([#465](https://github.com/TunneldeDev/Tunnelde/pull/465)) @quyansiyuanwang
- **window:** add transactional native panel workspaces ([#464](https://github.com/TunneldeDev/Tunnelde/pull/464)) @quyansiyuanwang
- **forwarding:** enable native panel window movement ([#469](https://github.com/TunneldeDev/Tunnelde/pull/469)) @quyansiyuanwang
- **mounts:** support owned mount startup from native plugin views ([#470](https://github.com/TunneldeDev/Tunnelde/pull/470)) @quyansiyuanwang
- **tasks:** preserve plugin providers across native windows ([#471](https://github.com/TunneldeDev/Tunnelde/pull/471)) @quyansiyuanwang
- **preview:** retain host-owned reads and scoped window handles ([#472](https://github.com/TunneldeDev/Tunnelde/pull/472)) @quyansiyuanwang
- **preview:** coordinate retained reads and renderer state ([#473](https://github.com/TunneldeDev/Tunnelde/pull/473)) @quyansiyuanwang
- **preview:** support retained native window rendering ([#474](https://github.com/TunneldeDev/Tunnelde/pull/474)) @quyansiyuanwang
- support native host-list window roundtrips ([#475](https://github.com/TunneldeDev/Tunnelde/pull/475)) @quyansiyuanwang
- support native plugin-list window roundtrips ([#476](https://github.com/TunneldeDev/Tunnelde/pull/476)) @quyansiyuanwang
- admit native host metadata reads ([#477](https://github.com/TunneldeDev/Tunnelde/pull/477)) @quyansiyuanwang
- prepare isolated terminal session handoff ([#478](https://github.com/TunneldeDev/Tunnelde/pull/478)) @quyansiyuanwang
- add leased native terminal stream endpoints ([#479](https://github.com/TunneldeDev/Tunnelde/pull/479)) @quyansiyuanwang
- retain live terminal sessions across native windows ([#481](https://github.com/TunneldeDev/Tunnelde/pull/481)) @quyansiyuanwang
- scope native file page directory operations ([#483](https://github.com/TunneldeDev/Tunnelde/pull/483)) @quyansiyuanwang
- retain native file page copy and transfer workers ([#484](https://github.com/TunneldeDev/Tunnelde/pull/484)) @quyansiyuanwang
- enable native SFTP workspace window roundtrips ([#485](https://github.com/TunneldeDev/Tunnelde/pull/485)) @quyansiyuanwang
- retain writable editors across native windows ([#486](https://github.com/TunneldeDev/Tunnelde/pull/486)) @quyansiyuanwang
- enable native host detail workspace windows ([#487](https://github.com/TunneldeDev/Tunnelde/pull/487)) @quyansiyuanwang

### 改进 | Improved

- **plugins:** move installable examples to the hub ([#467](https://github.com/TunneldeDev/Tunnelde/pull/467)) @quyansiyuanwang
- scope terminal rendering and retain closed handoff output ([#480](https://github.com/TunneldeDev/Tunnelde/pull/480)) @quyansiyuanwang
- isolate file page rendering from resource ownership ([#482](https://github.com/TunneldeDev/Tunnelde/pull/482)) @quyansiyuanwang

### 修复 | Fix

- **files:** align view menu checkmarks ([#427](https://github.com/TunneldeDev/Tunnelde/pull/427)) @quyansiyuanwang
- **editor:** accelerate scrollbar track scrolling ([#423](https://github.com/TunneldeDev/Tunnelde/pull/423)) @quyansiyuanwang
- **editor:** preserve selection across undo and redo ([#430](https://github.com/TunneldeDev/Tunnelde/pull/430)) @quyansiyuanwang
- **editor:** restore native scrolling ([#431](https://github.com/TunneldeDev/Tunnelde/pull/431)) @quyansiyuanwang
- **files:** repair SFTP path editing ([#436](https://github.com/TunneldeDev/Tunnelde/pull/436)) @quyansiyuanwang
- **editor:** align Chinese text to the monospace grid ([#437](https://github.com/TunneldeDev/Tunnelde/pull/437)) @quyansiyuanwang
- **editor:** allow save encoding changes after editing ([#438](https://github.com/TunneldeDev/Tunnelde/pull/438)) @quyansiyuanwang
- **editor:** support older WebKit CJK scaling and ship font license ([#440](https://github.com/TunneldeDev/Tunnelde/pull/440)) @quyansiyuanwang
- **ui:** polish continuous corners and preserve focus shapes ([#441](https://github.com/TunneldeDev/Tunnelde/pull/441)) @quyansiyuanwang
- **editor:** keep text cursor visible beside line numbers ([#442](https://github.com/TunneldeDev/Tunnelde/pull/442)) @quyansiyuanwang
- **hosts:** clarify transfer selection and index jump dependencies ([#453](https://github.com/TunneldeDev/Tunnelde/pull/453)) @quyansiyuanwang
- **plugins:** reconcile tool forms and native mount providers ([#455](https://github.com/TunneldeDev/Tunnelde/pull/455)) @quyansiyuanwang
- **ui:** recover failed imports and show accurate forwarding progress ([#456](https://github.com/TunneldeDev/Tunnelde/pull/456)) @quyansiyuanwang
- **editor:** recover failed reads and keep clean reconnects in sync ([#457](https://github.com/TunneldeDev/Tunnelde/pull/457)) @quyansiyuanwang
- **ui:** stabilize shared switches and compact provider settings ([#458](https://github.com/TunneldeDev/Tunnelde/pull/458)) @quyansiyuanwang
- **ui:** clarify forwarding hierarchy and add session controls ([#460](https://github.com/TunneldeDev/Tunnelde/pull/460)) @quyansiyuanwang
- **network:** distinguish tunnel setup from HTTPS response time ([#466](https://github.com/TunneldeDev/Tunnelde/pull/466)) @quyansiyuanwang

### 文档 | Docs

- **plugins:** clarify shared mount discovery and migration ([#449](https://github.com/TunneldeDev/Tunnelde/pull/449)) @quyansiyuanwang

### 其他 | Other

- unify brand assets and remove obsolete marketplace ([#433](https://github.com/TunneldeDev/Tunnelde/pull/433)) @quyansiyuanwang

</details>

### 贡献者 | Contributors

@quyansiyuanwang

## [1.4.4](https://github.com/TunneldeDev/Tunnelde/compare/v1.4.3...v1.4.4) - 2026-11-16

### 更新概览 | Highlights

- **deps:** bump the tooling group with 3 updates
- **deps:** bump uuid from 1.29.0 to 1.29.2 in /src-tauri
- **deps:** bump zustand from 5.0.16 to 5.1.0
- **deps:** bump tauri-plugin-opener from 2.7.2 to 2.7.3 in /src-tauri in the tauri group across 1 directory
- **deps:** bump lucide-react from 1.70.0 to 1.72.0

<details open>
<summary>详细变更 | Details (6)</summary>

### 修复 | Fix

- **deps:** bump the tooling group with 3 updates ([#417](https://github.com/TunneldeDev/Tunnelde/pull/417))
- **deps:** bump uuid from 1.29.0 to 1.29.2 in /src-tauri ([#418](https://github.com/TunneldeDev/Tunnelde/pull/418))
- **deps:** bump zustand from 5.0.16 to 5.1.0 ([#419](https://github.com/TunneldeDev/Tunnelde/pull/419))
- **deps:** bump tauri-plugin-opener from 2.7.2 to 2.7.3 in /src-tauri in the tauri group across 1 directory ([#420](https://github.com/TunneldeDev/Tunnelde/pull/420))
- **deps:** bump lucide-react from 1.70.0 to 1.72.0 ([#421](https://github.com/TunneldeDev/Tunnelde/pull/421))
- **editor:** use monospace font for code surfaces ([#422](https://github.com/TunneldeDev/Tunnelde/pull/422)) @quyansiyuanwang

</details>

### 贡献者 | Contributors

@quyansiyuanwang

## [1.4.3](https://github.com/TunneldeDev/Tunnelde/compare/v1.4.2...v1.4.3) - 2026-11-16

### 更新概览 | Highlights

- **qa:** preserve macOS updater relaunch failure evidence
- **settings:** size navigation rows to wrapped labels
- **plugins:** release policy while awaiting database admission
- **hosts:** move native and plugin snapshots onto bounded readers
- **plugins:** exercise policy admission on native platforms

<details open>
<summary>详细变更 | Details (5)</summary>

### 修复 | Fix

- **qa:** preserve macOS updater relaunch failure evidence ([#412](https://github.com/TunneldeDev/Tunnelde/pull/412)) @quyansiyuanwang
- **settings:** size navigation rows to wrapped labels ([#415](https://github.com/TunneldeDev/Tunnelde/pull/415)) @quyansiyuanwang
- **plugins:** release policy while awaiting database admission ([#414](https://github.com/TunneldeDev/Tunnelde/pull/414), [9809d95](https://github.com/TunneldeDev/Tunnelde/commit/9809d95fa56785dfe44ace4066c7991fda9a18b1)) @quyansiyuanwang
- **hosts:** move native and plugin snapshots onto bounded readers ([#416](https://github.com/TunneldeDev/Tunnelde/pull/416)) @quyansiyuanwang

### 构建 | Build

- **plugins:** exercise policy admission on native platforms ([#414](https://github.com/TunneldeDev/Tunnelde/pull/414)) @quyansiyuanwang

</details>

### 贡献者 | Contributors

@quyansiyuanwang

## [1.4.2](https://github.com/TunneldeDev/Tunnelde/compare/v1.4.1...v1.4.2) - 2026-11-16

### 更新概览 | Highlights

- **api:** isolate saved-host reads from async runtime
- **settings:** bound ordered preference reads outside async runtime
- **settings:** retain ordered writes outside async runtime
- **profiles:** retain catalogue operations outside UI runtime
- **macos:** retain native Quit failure diagnostics

<details open>
<summary>详细变更 | Details (5)</summary>

### 修复 | Fix

- **api:** isolate saved-host reads from async runtime ([#408](https://github.com/TunneldeDev/Tunnelde/pull/408)) @quyansiyuanwang
- **settings:** bound ordered preference reads outside async runtime ([#409](https://github.com/TunneldeDev/Tunnelde/pull/409)) @quyansiyuanwang
- **settings:** retain ordered writes outside async runtime ([#410](https://github.com/TunneldeDev/Tunnelde/pull/410)) @quyansiyuanwang
- **profiles:** retain catalogue operations outside UI runtime ([#411](https://github.com/TunneldeDev/Tunnelde/pull/411)) @quyansiyuanwang

### 构建 | Build

- **macos:** retain native Quit failure diagnostics ([#406](https://github.com/TunneldeDev/Tunnelde/pull/406)) @quyansiyuanwang

</details>

### 贡献者 | Contributors

@quyansiyuanwang

## [1.4.1](https://github.com/TunneldeDev/Tunnelde/compare/v1.4.0...v1.4.1) - 2026-11-15

### 更新概览 | Highlights

- **runners:** reject stale launches and messages before SSH dispatch
- **ssh:** retain bounded channel ownership through cancellation
- **tasks:** retain remote channel ownership through cancellation
- **ssh:** own plugin command channels through cancellation
- **monitor:** retain owned sampling channels through cancellation

<details open>
<summary>详细变更 | Details (11)</summary>

### 修复 | Fix

- **runners:** reject stale launches and messages before SSH dispatch ([#399](https://github.com/TunneldeDev/Tunnelde/pull/399), [3fb5b05](https://github.com/TunneldeDev/Tunnelde/commit/3fb5b053f5f3b15cd87bd72d5758d68e7c569435)) @quyansiyuanwang
- **ssh:** retain bounded channel ownership through cancellation ([#400](https://github.com/TunneldeDev/Tunnelde/pull/400)) @quyansiyuanwang
- **tasks:** retain remote channel ownership through cancellation ([#401](https://github.com/TunneldeDev/Tunnelde/pull/401)) @quyansiyuanwang
- **ssh:** own plugin command channels through cancellation ([#402](https://github.com/TunneldeDev/Tunnelde/pull/402)) @quyansiyuanwang
- **monitor:** retain owned sampling channels through cancellation ([#405](https://github.com/TunneldeDev/Tunnelde/pull/405)) @quyansiyuanwang
- **files:** own remote reader channels through cancellation ([#403](https://github.com/TunneldeDev/Tunnelde/pull/403), [c4feabd](https://github.com/TunneldeDev/Tunnelde/commit/c4feabd39327e917c8f60eb2196e93a22ec5e5f6)) @quyansiyuanwang

### 文档 | Docs

- keep Chinese helper links in the selected language ([#404](https://github.com/TunneldeDev/Tunnelde/pull/404)) @quyansiyuanwang

### 构建 | Build

- **macos:** accept explicit public stable OTA versions ([#397](https://github.com/TunneldeDev/Tunnelde/pull/397)) @quyansiyuanwang
- **runners:** exercise SSH dispatch fences on macOS and Windows ([#399](https://github.com/TunneldeDev/Tunnelde/pull/399)) @quyansiyuanwang
- **files:** observe completed SFTP stream ownership directly ([#403](https://github.com/TunneldeDev/Tunnelde/pull/403), [e9123d5](https://github.com/TunneldeDev/Tunnelde/commit/e9123d5cfcb772063448483301865a273f03e40f)) @quyansiyuanwang
- **files:** report competing journal admission outcomes ([#403](https://github.com/TunneldeDev/Tunnelde/pull/403)) @quyansiyuanwang

</details>

### 贡献者 | Contributors

@quyansiyuanwang

## [1.4.0](https://github.com/TunneldeDev/Tunnelde/compare/v1.3.1...v1.4.0) - 2026-11-15

### 更新概览 | Highlights

- **editor:** recover unsaved drafts after restart
- **ssh:** reuse atomic key publication
- **credentials:** model durable credential bindings
- **credentials:** stage native credential IO outside database guards
- **ssh:** release the database during reviewed password reads

<details open>
<summary>详细变更 | Details (32)</summary>

### 新增 | New

- **editor:** recover unsaved drafts after restart ([#377](https://github.com/TunneldeDev/Tunnelde/pull/377), [2cceb5c](https://github.com/TunneldeDev/Tunnelde/commit/2cceb5c773a5b9c47546114fc458a78a015e077c)) @quyansiyuanwang

### 改进 | Improved

- **ssh:** reuse atomic key publication ([#384](https://github.com/TunneldeDev/Tunnelde/pull/384)) @quyansiyuanwang
- **credentials:** model durable credential bindings ([#390](https://github.com/TunneldeDev/Tunnelde/pull/390), [6b5fadc](https://github.com/TunneldeDev/Tunnelde/commit/6b5fadc0e75aa4463597eb91a2691256b207e7bb)) @quyansiyuanwang
- **credentials:** stage native credential IO outside database guards ([#390](https://github.com/TunneldeDev/Tunnelde/pull/390), [f107c5a](https://github.com/TunneldeDev/Tunnelde/commit/f107c5a80901c130dc0bf944ae20b1a8fa3ead36)) @quyansiyuanwang

### 修复 | Fix

- **ssh:** release the database during reviewed password reads ([#374](https://github.com/TunneldeDev/Tunnelde/pull/374)) @quyansiyuanwang
- **ssh:** prepare connection reviews off the UI thread ([#375](https://github.com/TunneldeDev/Tunnelde/pull/375), [526c92d](https://github.com/TunneldeDev/Tunnelde/commit/526c92d8385fc35c2edd3f9a4653c79f8ebd99a9)) @quyansiyuanwang
- **ssh:** reject stale review inputs before proxy reads ([#375](https://github.com/TunneldeDev/Tunnelde/pull/375)) @quyansiyuanwang
- **editor:** retain consent fence through startup handoff ([#377](https://github.com/TunneldeDev/Tunnelde/pull/377)) @quyansiyuanwang
- **lifecycle:** checkpoint edits before tray quit and restart ([#378](https://github.com/TunneldeDev/Tunnelde/pull/378)) @quyansiyuanwang
- **editor:** coalesce shared checkpoint failure notices ([#379](https://github.com/TunneldeDev/Tunnelde/pull/379)) @quyansiyuanwang
- **ssh:** keep route credential checks off runtime threads ([#380](https://github.com/TunneldeDev/Tunnelde/pull/380), [0ec46bd](https://github.com/TunneldeDev/Tunnelde/commit/0ec46bdaf8b685581f246d39f16f32652bf4dc3a)) @quyansiyuanwang
- **ssh:** dispose sessions whose worker result is abandoned ([#380](https://github.com/TunneldeDev/Tunnelde/pull/380)) @quyansiyuanwang
- **plugins:** keep route preparation cancellable during credential reads ([#381](https://github.com/TunneldeDev/Tunnelde/pull/381)) @quyansiyuanwang
- **plugins:** recover running frontends after WebView reload ([#382](https://github.com/TunneldeDev/Tunnelde/pull/382)) @quyansiyuanwang
- **runners:** keep browser preparation cancellable ([#383](https://github.com/TunneldeDev/Tunnelde/pull/383)) @quyansiyuanwang
- **ssh:** preserve keys during login setup ([#384](https://github.com/TunneldeDev/Tunnelde/pull/384), [18629ef](https://github.com/TunneldeDev/Tunnelde/commit/18629ef66b3ff5560008545c84a3939ab8c7f44b)) @quyansiyuanwang
- **network:** prepare HTTP proxy routes off runtime threads ([#385](https://github.com/TunneldeDev/Tunnelde/pull/385), [524c197](https://github.com/TunneldeDev/Tunnelde/commit/524c19705a3dded2f12ff707943a85fb8f9606d6)) @quyansiyuanwang
- **network:** keep proxy diagnostics off runtime threads ([#386](https://github.com/TunneldeDev/Tunnelde/pull/386)) @quyansiyuanwang
- validate recovery browser effects without OS reads under authority locks ([#387](https://github.com/TunneldeDev/Tunnelde/pull/387)) @quyansiyuanwang
- prepare plugin process proxies without blocking runtime threads ([#388](https://github.com/TunneldeDev/Tunnelde/pull/388)) @quyansiyuanwang
- bound plugin keyring operations and fence queued writes ([#389](https://github.com/TunneldeDev/Tunnelde/pull/389)) @quyansiyuanwang
- **credentials:** bind native secrets to durable configuration authority ([#390](https://github.com/TunneldeDev/Tunnelde/pull/390)) @quyansiyuanwang
- **credentials:** explain pending recovery before retrying saves ([#391](https://github.com/TunneldeDev/Tunnelde/pull/391)) @quyansiyuanwang
- **sshfs:** propagate transport EOF without losing final responses ([#395](https://github.com/TunneldeDev/Tunnelde/pull/395), [b561456](https://github.com/TunneldeDev/Tunnelde/commit/b56145608591a64da4bca7a9df617d903635f0f6)) @quyansiyuanwang
- **sshfs:** bound final drain when passive process remains open ([#395](https://github.com/TunneldeDev/Tunnelde/pull/395)) @quyansiyuanwang
- **sshfs:** bound subsystem negotiation without blocking mount cleanup ([#396](https://github.com/TunneldeDev/Tunnelde/pull/396)) @quyansiyuanwang

### 构建 | Build

- **network:** exercise HTTP workers on macOS and Windows ([#385](https://github.com/TunneldeDev/Tunnelde/pull/385)) @quyansiyuanwang
- **credentials:** verify native binding lifecycle in isolated keyring ([#391](https://github.com/TunneldeDev/Tunnelde/pull/391), [2176147](https://github.com/TunneldeDev/Tunnelde/commit/2176147c7688888c210c1fee16ea72e28c66ced3)) @quyansiyuanwang
- **credentials:** verify native bindings in macOS Keychain ([#392](https://github.com/TunneldeDev/Tunnelde/pull/392)) @quyansiyuanwang
- **updates:** retain download evidence across WebView exit ([#393](https://github.com/TunneldeDev/Tunnelde/pull/393)) @quyansiyuanwang
- **updates:** validate explicit Linux public upgrade targets ([#394](https://github.com/TunneldeDev/Tunnelde/pull/394)) @quyansiyuanwang
- **sshfs:** exercise owned mounts through authenticated SSH ([#395](https://github.com/TunneldeDev/Tunnelde/pull/395), [5d55e7f](https://github.com/TunneldeDev/Tunnelde/commit/5d55e7f8877df844083688129e59119567826a68)) @quyansiyuanwang

</details>

### 贡献者 | Contributors

@quyansiyuanwang

## [1.3.1](https://github.com/TunneldeDev/Tunnelde/compare/v1.3.0...v1.3.1) - 2026-11-15

### 更新概览 | Highlights

- **updates:** invalidate packages when source preferences change
- **welcome:** show configured platform keyboard shortcuts
- **qa:** encode native capability flags as JSON booleans
- **credentials:** move native password commands off the UI thread
- **connect:** report target credential status failures

<details open>
<summary>详细变更 | Details (18)</summary>

### 修复 | Fix

- **updates:** invalidate packages when source preferences change ([#361](https://github.com/TunneldeDev/Tunnelde/pull/361)) @quyansiyuanwang
- **welcome:** show configured platform keyboard shortcuts ([#363](https://github.com/TunneldeDev/Tunnelde/pull/363)) @quyansiyuanwang
- **qa:** encode native capability flags as JSON booleans ([#364](https://github.com/TunneldeDev/Tunnelde/pull/364), [2c284cd](https://github.com/TunneldeDev/Tunnelde/commit/2c284cdc41374f38e7637353918ab837dc01b1ff)) @quyansiyuanwang
- **credentials:** move native password commands off the UI thread ([#372](https://github.com/TunneldeDev/Tunnelde/pull/372), [263d248](https://github.com/TunneldeDev/Tunnelde/commit/263d248b310aba75eb2c1985438529465ef0e05d)) @quyansiyuanwang
- **connect:** report target credential status failures ([#372](https://github.com/TunneldeDev/Tunnelde/pull/372)) @quyansiyuanwang
- **files:** keep native local operations off the UI thread ([#373](https://github.com/TunneldeDev/Tunnelde/pull/373)) @quyansiyuanwang

### 文档 | Docs

- **qa:** clarify manual workflow registration checks ([#364](https://github.com/TunneldeDev/Tunnelde/pull/364), [bea93bb](https://github.com/TunneldeDev/Tunnelde/commit/bea93bbf8a5b906d401994cf0663ac83bb79ac85)) @quyansiyuanwang

### 构建 | Build

- **macos:** add guarded hosted OTA environment probe ([#364](https://github.com/TunneldeDev/Tunnelde/pull/364), [ba50b45](https://github.com/TunneldeDev/Tunnelde/commit/ba50b455f78dbf9b30536251ad3fdb196a4654be)) @quyansiyuanwang
- **macos:** derive hosted account paths for hygiene checks ([#364](https://github.com/TunneldeDev/Tunnelde/pull/364), [c5e22df](https://github.com/TunneldeDev/Tunnelde/commit/c5e22df28ab34e6ed575c2e75f45f831dd7807f8)) @quyansiyuanwang
- **macos:** make hosted guard tests portable on Windows ([#364](https://github.com/TunneldeDev/Tunnelde/pull/364)) @quyansiyuanwang
- **update:** verify public Linux desktop entry ([#365](https://github.com/TunneldeDev/Tunnelde/pull/365)) @quyansiyuanwang
- **update:** verify public Linux AppImage upgrades ([#367](https://github.com/TunneldeDev/Tunnelde/pull/367)) @quyansiyuanwang
- **update:** verify retained Linux host and profile records ([#369](https://github.com/TunneldeDev/Tunnelde/pull/369)) @quyansiyuanwang
- **ssh:** reserve the pending remote forwarding listener ([#371](https://github.com/TunneldeDev/Tunnelde/pull/371)) @quyansiyuanwang
- **updates:** control shared request deadline regression ([#370](https://github.com/TunneldeDev/Tunnelde/pull/370)) @quyansiyuanwang
- **macos:** verify public app update on disposable hosted Mac ([#366](https://github.com/TunneldeDev/Tunnelde/pull/366)) @quyansiyuanwang
- **credentials:** run worker regressions on macOS and Windows ([#372](https://github.com/TunneldeDev/Tunnelde/pull/372), [2db39cd](https://github.com/TunneldeDev/Tunnelde/commit/2db39cdbe1ad1c9377d52b9ef6b0aa2369a32038)) @quyansiyuanwang
- **macos:** verify public OTA data retention ([#368](https://github.com/TunneldeDev/Tunnelde/pull/368)) @quyansiyuanwang

</details>

### 贡献者 | Contributors

@quyansiyuanwang

## [1.3.0](https://github.com/TunneldeDev/Tunnelde/compare/v1.2.1...v1.3.0) - 2026-11-14

### 更新概览 | Highlights

- **editor:** cancel active native saves through original workers
- **connect:** preserve IME Enter in credential dialogs
- **terminal:** suppress orphan IME Enter releases
- **storage:** reserve overlapping category locations across instances
- **storage:** reserve bootstrap homes before creating files

<details open>
<summary>详细变更 | Details (16)</summary>

### 新增 | New

- **editor:** cancel active native saves through original workers ([#357](https://github.com/TunneldeDev/Tunnelde/pull/357), [abbb37c](https://github.com/TunneldeDev/Tunnelde/commit/abbb37c0e51cde76bc8ee8b34c6e30abc3da6fb1)) @quyansiyuanwang

### 修复 | Fix

- **connect:** preserve IME Enter in credential dialogs ([#350](https://github.com/TunneldeDev/Tunnelde/pull/350)) @quyansiyuanwang
- **terminal:** suppress orphan IME Enter releases ([#352](https://github.com/TunneldeDev/Tunnelde/pull/352)) @quyansiyuanwang
- **storage:** reserve overlapping category locations across instances ([#353](https://github.com/TunneldeDev/Tunnelde/pull/353), [92ca73b](https://github.com/TunneldeDev/Tunnelde/commit/92ca73b2e9a6ab7f8afc3c71e75042a7a5a80e62)) @quyansiyuanwang
- **storage:** reserve bootstrap homes before creating files ([#353](https://github.com/TunneldeDev/Tunnelde/pull/353), [1adb3f1](https://github.com/TunneldeDev/Tunnelde/commit/1adb3f19b082a3ed82e6e97899b93c16e7799517)) @quyansiyuanwang
- **storage:** coordinate macOS Unicode path aliases ([#353](https://github.com/TunneldeDev/Tunnelde/pull/353)) @quyansiyuanwang
- **credentials:** scope system vault to the application ([#354](https://github.com/TunneldeDev/Tunnelde/pull/354)) @quyansiyuanwang
- **files:** resolve Windows SFTP paths for native saves ([#356](https://github.com/TunneldeDev/Tunnelde/pull/356), [f35bbc3](https://github.com/TunneldeDev/Tunnelde/commit/f35bbc35f5a47625381110aa45852dfee79c67d4)) @quyansiyuanwang
- **files:** bind Windows saves to native canonical folders ([#356](https://github.com/TunneldeDev/Tunnelde/pull/356), [702f6d5](https://github.com/TunneldeDev/Tunnelde/commit/702f6d59851e50de7a4822d85634c5ace4b4ec85)) @quyansiyuanwang
- **files:** pin the verified SSH worker lifecycle patch ([#356](https://github.com/TunneldeDev/Tunnelde/pull/356)) @quyansiyuanwang
- **automation:** close owned listener and requests on shutdown ([#358](https://github.com/TunneldeDev/Tunnelde/pull/358)) @quyansiyuanwang
- **editor:** distinguish confirmed cancellation in recovery feedback ([#357](https://github.com/TunneldeDev/Tunnelde/pull/357), [2a24fe8](https://github.com/TunneldeDev/Tunnelde/commit/2a24fe8bdf970eebd4e07a39439aa99e02d1c8ae)) @quyansiyuanwang
- **files:** pin verified macOS save cleanup repair ([#357](https://github.com/TunneldeDev/Tunnelde/pull/357)) @quyansiyuanwang
- **tasks:** keep floating tasks below modal dialogs ([#359](https://github.com/TunneldeDev/Tunnelde/pull/359)) @quyansiyuanwang
- **forwards:** release removed entries after unlocking registry ([#360](https://github.com/TunneldeDev/Tunnelde/pull/360)) @quyansiyuanwang

### 文档 | Docs

- **files:** reflect explicit native save setup ([#355](https://github.com/TunneldeDev/Tunnelde/pull/355)) @quyansiyuanwang

</details>

### 贡献者 | Contributors

@quyansiyuanwang

## [1.2.1](https://github.com/TunneldeDev/Tunnelde/compare/v1.2.0...v1.2.1) - 2026-11-14

### 更新概览 | Highlights

- **storage:** own the data home for the application lifetime
- **storage:** preserve databases when startup cannot open them
- **ui:** unify search toolbar layout in docked panels
- **storage:** release Unix ownership before inherited children exec
- **updates:** install verified macOS bundles through native updater

<details open>
<summary>详细变更 | Details (7)</summary>

### 修复 | Fix

- **storage:** own the data home for the application lifetime ([#345](https://github.com/TunneldeDev/Tunnelde/pull/345), [91a4523](https://github.com/TunneldeDev/Tunnelde/commit/91a452368ff0148216f59ae84343676e5a6ca69d)) @quyansiyuanwang
- **storage:** preserve databases when startup cannot open them ([#346](https://github.com/TunneldeDev/Tunnelde/pull/346)) @quyansiyuanwang
- **ui:** unify search toolbar layout in docked panels ([#347](https://github.com/TunneldeDev/Tunnelde/pull/347)) @quyansiyuanwang
- **storage:** release Unix ownership before inherited children exec ([#348](https://github.com/TunneldeDev/Tunnelde/pull/348)) @quyansiyuanwang
- **updates:** install verified macOS bundles through native updater ([#349](https://github.com/TunneldeDev/Tunnelde/pull/349)) @quyansiyuanwang

### 文档 | Docs

- **api:** distinguish stable core and forwarding behavior ([#343](https://github.com/TunneldeDev/Tunnelde/pull/343)) @quyansiyuanwang

### 构建 | Build

- **storage:** create FIFO fixtures on macOS and Linux ([#345](https://github.com/TunneldeDev/Tunnelde/pull/345)) @quyansiyuanwang

</details>

### 贡献者 | Contributors

@quyansiyuanwang

## [1.2.0](https://github.com/TunneldeDev/Tunnelde/compare/v1.1.0...v1.2.0) - 2026-11-13

### 更新概览 | Highlights

- **cli:** bound native confirmation time independently of framing
- **cli:** confirm conditional forwarding changes through shared services
- **api:** add consent-bound forwarding startup receipts
- **forwarding:** deliver external startup through the reviewed connection dialog
- **cli:** check authentication deadline before extending execution

<details open>
<summary>详细变更 | Details (13)</summary>

### 新增 | New

- **cli:** bound native confirmation time independently of framing ([#336](https://github.com/TunneldeDev/Tunnelde/pull/336), [784f5f4](https://github.com/TunneldeDev/Tunnelde/commit/784f5f492f39101b785f9167d7712554a5a12215)) @quyansiyuanwang
- **cli:** confirm conditional forwarding changes through shared services ([#336](https://github.com/TunneldeDev/Tunnelde/pull/336), [95ac7ba](https://github.com/TunneldeDev/Tunnelde/commit/95ac7ba2303939ba85689c95af5f863e668698c5)) @quyansiyuanwang
- **api:** add consent-bound forwarding startup receipts ([#341](https://github.com/TunneldeDev/Tunnelde/pull/341), [aedbba3](https://github.com/TunneldeDev/Tunnelde/commit/aedbba3d71ea19f114799688f1072efeaa28939c)) @quyansiyuanwang
- **forwarding:** deliver external startup through the reviewed connection dialog ([#341](https://github.com/TunneldeDev/Tunnelde/pull/341), [b5fd00d](https://github.com/TunneldeDev/Tunnelde/commit/b5fd00d6becf25ad5e94f2917dd1fab2eeb1546b)) @quyansiyuanwang

### 修复 | Fix

- **cli:** check authentication deadline before extending execution ([#336](https://github.com/TunneldeDev/Tunnelde/pull/336)) @quyansiyuanwang
- **ssh:** pin complete routes across pending connections ([#338](https://github.com/TunneldeDev/Tunnelde/pull/338), [14b8097](https://github.com/TunneldeDev/Tunnelde/commit/14b809760c0e7c64920e37ffdc5988fa3d988ece)) @quyansiyuanwang
- **ssh:** keep quality samples on the reviewed route ([#338](https://github.com/TunneldeDev/Tunnelde/pull/338)) @quyansiyuanwang
- **ssh:** retain reviewed routes across connection attempts ([#339](https://github.com/TunneldeDev/Tunnelde/pull/339), [b7f69f7](https://github.com/TunneldeDev/Tunnelde/commit/b7f69f781304a1fae6ed090e8527223c5be90e4b)) @quyansiyuanwang
- **connect:** bind dialog actions to the reviewed destination ([#339](https://github.com/TunneldeDev/Tunnelde/pull/339)) @quyansiyuanwang
- **forwarding:** reject duplicate admission before publishing resources ([#340](https://github.com/TunneldeDev/Tunnelde/pull/340)) @quyansiyuanwang
- **window:** bind close approval to the current document ([#341](https://github.com/TunneldeDev/Tunnelde/pull/341)) @quyansiyuanwang
- **recovery:** retain reviewed routes across browser acquisition ([#342](https://github.com/TunneldeDev/Tunnelde/pull/342)) @quyansiyuanwang

### 构建 | Build

- **ssh:** run session regressions on desktop platforms ([#338](https://github.com/TunneldeDev/Tunnelde/pull/338), [c7518f7](https://github.com/TunneldeDev/Tunnelde/commit/c7518f7988dd02dbd5ef440191f91d4bc3050fb4)) @quyansiyuanwang

</details>

### 贡献者 | Contributors

@quyansiyuanwang

## [1.1.0](https://github.com/TunneldeDev/Tunnelde/compare/v1.0.0...v1.1.0) - 2026-11-13

### 更新概览 | Highlights

- **files:** arbitrate legacy and native claims in one durable journal
- **files:** retain durable mutation ownership in actual remote workers
- **files:** extend original transfer reservations atomically
- **files:** observe original transfer channel writes and handles
- **files:** observe transfer metadata writes and directory creation

<details open>
<summary>详细变更 | Details (36)</summary>

### 新增 | New

- **files:** arbitrate legacy and native claims in one durable journal ([#309](https://github.com/TunneldeDev/Tunnelde/pull/309), [cbfa3f2](https://github.com/TunneldeDev/Tunnelde/commit/cbfa3f2bbbf1fa44c722291d25f6cb24892d6bf3)) @quyansiyuanwang
- **files:** retain durable mutation ownership in actual remote workers ([#309](https://github.com/TunneldeDev/Tunnelde/pull/309), [e2b760f](https://github.com/TunneldeDev/Tunnelde/commit/e2b760f7decf2a87d2516562235de49848587c0d)) @quyansiyuanwang
- **files:** extend original transfer reservations atomically ([#309](https://github.com/TunneldeDev/Tunnelde/pull/309), [af54663](https://github.com/TunneldeDev/Tunnelde/commit/af546637eb3e118e9c7a29c11cb72bd0ab2a63c2)) @quyansiyuanwang
- **files:** observe original transfer channel writes and handles ([#309](https://github.com/TunneldeDev/Tunnelde/pull/309), [aa5b09a](https://github.com/TunneldeDev/Tunnelde/commit/aa5b09aa4e1cfaec73f7895452b145509ef166b4)) @quyansiyuanwang
- **files:** observe transfer metadata writes and directory creation ([#309](https://github.com/TunneldeDev/Tunnelde/pull/309), [0fc1e65](https://github.com/TunneldeDev/Tunnelde/commit/0fc1e650a901983821283146d1ffc103be14a816)) @quyansiyuanwang
- **files:** retain parked transfer ownership across continuation ([#309](https://github.com/TunneldeDev/Tunnelde/pull/309), [a669b31](https://github.com/TunneldeDev/Tunnelde/commit/a669b311e710f1add51bfd35b42f5fc74709f037)) @quyansiyuanwang
- **files:** retain task epochs through publication and cleanup ([#309](https://github.com/TunneldeDev/Tunnelde/pull/309), [6fc7e4e](https://github.com/TunneldeDev/Tunnelde/commit/6fc7e4ef976ac68eddfa1970b32152a41b539373)) @quyansiyuanwang
- **files:** bind immutable transfer intent to recovery claims ([#309](https://github.com/TunneldeDev/Tunnelde/pull/309), [413646a](https://github.com/TunneldeDev/Tunnelde/commit/413646ad265721daf2806a3129432b2a2510c8c5)) @quyansiyuanwang
- **files:** retain original transfer ownership through run and cleanup ([#309](https://github.com/TunneldeDev/Tunnelde/pull/309), [87cc828](https://github.com/TunneldeDev/Tunnelde/commit/87cc82883a1f380f7df46e6898718b640759f1e5)) @quyansiyuanwang
- **files:** persist terminal handoff before retiring transfer claims ([#309](https://github.com/TunneldeDev/Tunnelde/pull/309), [073cdb4](https://github.com/TunneldeDev/Tunnelde/commit/073cdb44976552b06aa9603db2544647e239d063)) @quyansiyuanwang
- **cli:** read structured logs through the shared domain service ([#329](https://github.com/TunneldeDev/Tunnelde/pull/329), [ce6bd59](https://github.com/TunneldeDev/Tunnelde/commit/ce6bd590f0cf7ff6b67f29bc55f9a183aef3ad21)) @quyansiyuanwang
- **cli:** expose bounded live forwarding status ([#330](https://github.com/TunneldeDev/Tunnelde/pull/330), [e44b3a7](https://github.com/TunneldeDev/Tunnelde/commit/e44b3a7dfdf0346a3ea70622c78207412689c60d)) @quyansiyuanwang
- **files:** retain native helper installation checkpoints ([#333](https://github.com/TunneldeDev/Tunnelde/pull/333), [e7ed03e](https://github.com/TunneldeDev/Tunnelde/commit/e7ed03ea927b84230b21d87bcc845db80ec59e39)) @quyansiyuanwang
- **files:** expose uncertain installations in recovery ([#333](https://github.com/TunneldeDev/Tunnelde/pull/333), [3207995](https://github.com/TunneldeDev/Tunnelde/commit/3207995d15cab4c6f7663eb35b21bb595609a3fa)) @quyansiyuanwang
- **files:** install and recover native remote editor saves ([#335](https://github.com/TunneldeDev/Tunnelde/pull/335), [46dd5a2](https://github.com/TunneldeDev/Tunnelde/commit/46dd5a2f506cd38e00f259e4af18261996cbaa49)) @quyansiyuanwang
- **editor:** offer recoverable saves for remote folders ([#335](https://github.com/TunneldeDev/Tunnelde/pull/335)) @quyansiyuanwang

### 改进 | Improved

- **network:** simplify TLS error classification ([#335](https://github.com/TunneldeDev/Tunnelde/pull/335), [a9191d6](https://github.com/TunneldeDev/Tunnelde/commit/a9191d6c249ef7cd5d129a6a77afa4d747d733d5)) @quyansiyuanwang

### 修复 | Fix

- **files:** settle original replies without releasing deferred cleanup ([#309](https://github.com/TunneldeDev/Tunnelde/pull/309), [fcdff0c](https://github.com/TunneldeDev/Tunnelde/commit/fcdff0ca04f902f07eabe88a7ed4fa1ce61ce8a1)) @quyansiyuanwang
- **files:** resume exact owned editor cleanup ([#309](https://github.com/TunneldeDev/Tunnelde/pull/309), [af56240](https://github.com/TunneldeDev/Tunnelde/commit/af5624042dc825a0546eb4497526dd30fcb2d56c)) @quyansiyuanwang
- **files:** revalidate plugin authorization at remote mutation dispatch ([#309](https://github.com/TunneldeDev/Tunnelde/pull/309), [76c548f](https://github.com/TunneldeDev/Tunnelde/commit/76c548f7eb13db30593436c0ed04e97317acf247)) @quyansiyuanwang
- **files:** preserve original transfer roots and late reply ownership ([#309](https://github.com/TunneldeDev/Tunnelde/pull/309), [a7e680b](https://github.com/TunneldeDev/Tunnelde/commit/a7e680b5f04934efd709ca805b5450454dcbd9b5)) @quyansiyuanwang
- **files:** retain original metadata workers after cancellation ([#309](https://github.com/TunneldeDev/Tunnelde/pull/309), [1c45694](https://github.com/TunneldeDev/Tunnelde/commit/1c456941dc5c0c05f0e3f0c7eb5a6ce35ce3aa3b)) @quyansiyuanwang
- **files:** recheck live transfer authority before queued writes ([#309](https://github.com/TunneldeDev/Tunnelde/pull/309), [1daa001](https://github.com/TunneldeDev/Tunnelde/commit/1daa00167a66b7e3d6653301190973b88eed6d3f)) @quyansiyuanwang
- **files:** isolate host disposal from revoked plugin execution ([#309](https://github.com/TunneldeDev/Tunnelde/pull/309), [7de3b30](https://github.com/TunneldeDev/Tunnelde/commit/7de3b300078915d5d4c1fb7a1d7f6d7ad610d903)) @quyansiyuanwang
- **files:** drain original writable handles before pausing transfers ([#309](https://github.com/TunneldeDev/Tunnelde/pull/309), [312ba2b](https://github.com/TunneldeDev/Tunnelde/commit/312ba2baa1dfe57e505f9056ecbc5dd5e8e11817)) @quyansiyuanwang
- **files:** fence canonical scope expansion and preserve completion failures ([#309](https://github.com/TunneldeDev/Tunnelde/pull/309), [3d392c9](https://github.com/TunneldeDev/Tunnelde/commit/3d392c9f2c5baf20c972f4243f6e98f4583d71ea)) @quyansiyuanwang
- **files:** retain original SFTP data workers through cancellation ([#309](https://github.com/TunneldeDev/Tunnelde/pull/309), [b0193b4](https://github.com/TunneldeDev/Tunnelde/commit/b0193b42abfa6b1d1bcfd446ffd9fd0a871ade98)) @quyansiyuanwang
- **files:** preserve typed admission errors for queued requests ([#309](https://github.com/TunneldeDev/Tunnelde/pull/309)) @quyansiyuanwang
- **storage:** preserve deferred restart notices across reconciliation ([#328](https://github.com/TunneldeDev/Tunnelde/pull/328)) @quyansiyuanwang
- **files:** protect installation paths during transfer extension ([#333](https://github.com/TunneldeDev/Tunnelde/pull/333)) @quyansiyuanwang
- **network:** use Windows TLS for proxy downloads ([#335](https://github.com/TunneldeDev/Tunnelde/pull/335), [601457e](https://github.com/TunneldeDev/Tunnelde/commit/601457e8ea6fa025125932ffc558c9f2cb4ce9d8)) @quyansiyuanwang

### 构建 | Build

- **cli:** cover piped queries and platform log-reader lifetimes ([#329](https://github.com/TunneldeDev/Tunnelde/pull/329)) @quyansiyuanwang
- **cli:** cover forwarding consumers and document pagination ([#330](https://github.com/TunneldeDev/Tunnelde/pull/330)) @quyansiyuanwang
- **cli:** normalize accepted fixture socket mode ([#331](https://github.com/TunneldeDev/Tunnelde/pull/331)) @quyansiyuanwang
- **ssh:** retain forwarding port reservations during setup ([#332](https://github.com/TunneldeDev/Tunnelde/pull/332)) @quyansiyuanwang
- **network:** exercise Windows TLS transport in CI ([#335](https://github.com/TunneldeDev/Tunnelde/pull/335), [c6fb1bd](https://github.com/TunneldeDev/Tunnelde/commit/c6fb1bd5af150ae76f40fd7da3aa5267dbebaed8)) @quyansiyuanwang

</details>

### 贡献者 | Contributors

@quyansiyuanwang

## [1.0.0](https://github.com/TunneldeDev/Tunnelde/compare/v0.38.0...v1.0.0) - 2026-11-13

### 更新概览 | Highlights

- **api:** freeze the seven local v1 contracts
- **api:** define the finite local stability boundary
- **release:** support reviewed milestone targets
- **api:** verify stable contracts in public milestone packages
- **release:** select the first stable milestone

<details open>
<summary>详细变更 | Details (5)</summary>

### 新增 | New

- **api:** freeze the seven local v1 contracts ([#323](https://github.com/TunneldeDev/Tunnelde/pull/323), [5a0b47f](https://github.com/TunneldeDev/Tunnelde/commit/5a0b47fa251487597a371f89ca36670924c7b0d1)) @quyansiyuanwang

### 文档 | Docs

- **api:** define the finite local stability boundary ([#323](https://github.com/TunneldeDev/Tunnelde/pull/323)) @quyansiyuanwang

### 构建 | Build

- **release:** support reviewed milestone targets ([#325](https://github.com/TunneldeDev/Tunnelde/pull/325), [26a3d98](https://github.com/TunneldeDev/Tunnelde/commit/26a3d989dfa7a7dfb143cf23e02da57944fbe145)) @quyansiyuanwang
- **api:** verify stable contracts in public milestone packages ([#326](https://github.com/TunneldeDev/Tunnelde/pull/326)) @quyansiyuanwang

### 其他 | Other

- **release:** select the first stable milestone ([#325](https://github.com/TunneldeDev/Tunnelde/pull/325)) @quyansiyuanwang

</details>

### 贡献者 | Contributors

@quyansiyuanwang

## [0.38.0](https://github.com/TunneldeDev/Tunnelde/compare/v0.37.0...v0.38.0) - 2026-11-13

### 更新概览 | Highlights

- **api:** add versioned local automation and desktop CLI
- **api:** expose revision-checked public preferences through CLI
- **api:** close local protocol and CLI compatibility contracts
- **cli:** bound local client requests by an absolute deadline
- **storage:** make link checks explicit across platforms

<details open>
<summary>详细变更 | Details (26)</summary>

### 新增 | New

- **api:** add versioned local automation and desktop CLI ([#310](https://github.com/TunneldeDev/Tunnelde/pull/310), [5cb69ee](https://github.com/TunneldeDev/Tunnelde/commit/5cb69ee41c6ef93d38b7227b216d10bd98f7d5e8)) @quyansiyuanwang
- **api:** expose revision-checked public preferences through CLI ([#312](https://github.com/TunneldeDev/Tunnelde/pull/312), [1fc11a0](https://github.com/TunneldeDev/Tunnelde/commit/1fc11a018441e494512f83969c7153c3d2806dc3)) @quyansiyuanwang

### 修复 | Fix

- **api:** close local protocol and CLI compatibility contracts ([#313](https://github.com/TunneldeDev/Tunnelde/pull/313)) @quyansiyuanwang
- **cli:** bound local client requests by an absolute deadline ([#314](https://github.com/TunneldeDev/Tunnelde/pull/314), [6ce39a6](https://github.com/TunneldeDev/Tunnelde/commit/6ce39a61f085a662410beb78a76bb27d00243f45)) @quyansiyuanwang
- **storage:** make link checks explicit across platforms ([#314](https://github.com/TunneldeDev/Tunnelde/pull/314)) @quyansiyuanwang
- **files:** reorder columns by dragging header labels ([#319](https://github.com/TunneldeDev/Tunnelde/pull/319)) @quyansiyuanwang
- **hosts:** honor tree fields and scroll narrow host tables ([#320](https://github.com/TunneldeDev/Tunnelde/pull/320), [1ba6c92](https://github.com/TunneldeDev/Tunnelde/commit/1ba6c92704aaf0db88307152956c32c66be64650)) @quyansiyuanwang
- **workspace:** clear activity selection when a panel closes ([#320](https://github.com/TunneldeDev/Tunnelde/pull/320), [d4555ed](https://github.com/TunneldeDev/Tunnelde/commit/d4555ed802023bf4428b70e2c73b5280ca5063f6)) @quyansiyuanwang
- **settings:** collapse storage locations and align plugin sections ([#320](https://github.com/TunneldeDev/Tunnelde/pull/320), [f32be13](https://github.com/TunneldeDev/Tunnelde/commit/f32be131cca3b41a4db543982e421c593774e462)) @quyansiyuanwang
- **preview:** align the dock action icon with its label ([#320](https://github.com/TunneldeDev/Tunnelde/pull/320)) @quyansiyuanwang
- **updates:** avoid blocking Windows updates on language selection ([#321](https://github.com/TunneldeDev/Tunnelde/pull/321)) @quyansiyuanwang
- **api:** define a finite local discovery result contract ([#322](https://github.com/TunneldeDev/Tunnelde/pull/322), [961f680](https://github.com/TunneldeDev/Tunnelde/commit/961f680ed850782d7e3d7bb4c5d8d58beb6f8144)) @quyansiyuanwang

### 文档 | Docs

- **api:** define local contract closure and CLI usage ([#310](https://github.com/TunneldeDev/Tunnelde/pull/310)) @quyansiyuanwang
- **api:** document preference updates and conflict handling ([#312](https://github.com/TunneldeDev/Tunnelde/pull/312)) @quyansiyuanwang
- **api:** define finite local compatibility and migration policy ([#316](https://github.com/TunneldeDev/Tunnelde/pull/316)) @quyansiyuanwang

### 构建 | Build

- **release:** verify public Windows installer upgrades ([#315](https://github.com/TunneldeDev/Tunnelde/pull/315), [53f9b81](https://github.com/TunneldeDev/Tunnelde/commit/53f9b8174dc9702d642c10c293aafa06ac1a24f6)) @quyansiyuanwang
- **release:** capture WebView readiness diagnostics ([#315](https://github.com/TunneldeDev/Tunnelde/pull/315), [74f62d5](https://github.com/TunneldeDev/Tunnelde/commit/74f62d53273819831fbc0227fa8ddb96bb89bbaf)) @quyansiyuanwang
- **release:** support elevated hosted WebView2 debugging ([#315](https://github.com/TunneldeDev/Tunnelde/pull/315), [7d36ed4](https://github.com/TunneldeDev/Tunnelde/commit/7d36ed459e7cf5ed0013e8fffad620e70551cdf0)) @quyansiyuanwang
- **api:** verify installed CLI in release upgrade acceptance ([#315](https://github.com/TunneldeDev/Tunnelde/pull/315)) @quyansiyuanwang
- **cli:** verify public macOS and Linux packages against local services ([#317](https://github.com/TunneldeDev/Tunnelde/pull/317)) @quyansiyuanwang
- **cli:** verify refined discovery alongside historical contracts ([#322](https://github.com/TunneldeDev/Tunnelde/pull/322)) @quyansiyuanwang
- **updates:** exercise signed public Windows update and automatic restart ([#318](https://github.com/TunneldeDev/Tunnelde/pull/318), [d7b7cb1](https://github.com/TunneldeDev/Tunnelde/commit/d7b7cb199600bf51003a5d283c50648b53e7379a)) @quyansiyuanwang
- **updates:** use normal channel discovery for public OTA acceptance ([#318](https://github.com/TunneldeDev/Tunnelde/pull/318), [abf4156](https://github.com/TunneldeDev/Tunnelde/commit/abf4156513449e656600e4382b1a673b9705b023)) @quyansiyuanwang
- **updates:** retain installer and restart diagnostics after handoff ([#318](https://github.com/TunneldeDev/Tunnelde/pull/318), [7a490ea](https://github.com/TunneldeDev/Tunnelde/commit/7a490ea711ad99b8dd4d8de4129d3d5de43a8f25)) @quyansiyuanwang
- **updates:** target the unattended public beta installer ([#318](https://github.com/TunneldeDev/Tunnelde/pull/318), [df77396](https://github.com/TunneldeDev/Tunnelde/commit/df77396a9c29b43ee9d728f5ae4513814269f04b)) @quyansiyuanwang
- **updates:** preserve native profile across installer restart ([#318](https://github.com/TunneldeDev/Tunnelde/pull/318)) @quyansiyuanwang

</details>

### 贡献者 | Contributors

@quyansiyuanwang

## [0.37.0](https://github.com/TunneldeDev/Tunnelde/compare/v0.36.0...v0.37.0) - 2026-11-12

### 更新概览 | Highlights

- **files:** dock live previews in remembered workspace panels
- **files:** add bound native save host protocol
- **files:** checkpoint native saves before dispatch
- **files:** show original save recovery actions in background tasks
- **ssh:** share remote command encoding

<details open>
<summary>详细变更 | Details (24)</summary>

### 新增 | New

- **files:** dock live previews in remembered workspace panels ([#304](https://github.com/TunneldeDev/Tunnelde/pull/304), [34ba397](https://github.com/TunneldeDev/Tunnelde/commit/34ba397518b135d2396b44deb62fd77a0956bd19)) @quyansiyuanwang
- **files:** add bound native save host protocol ([#305](https://github.com/TunneldeDev/Tunnelde/pull/305), [8f023a9](https://github.com/TunneldeDev/Tunnelde/commit/8f023a95a1d6e648f52cdc087b193aad616a8eb2)) @quyansiyuanwang
- **files:** checkpoint native saves before dispatch ([#306](https://github.com/TunneldeDev/Tunnelde/pull/306), [65d40ce](https://github.com/TunneldeDev/Tunnelde/commit/65d40ce96a45f3426ddb7f42f000f5c413daae0b)) @quyansiyuanwang
- **files:** show original save recovery actions in background tasks ([#307](https://github.com/TunneldeDev/Tunnelde/pull/307), [9575d9a](https://github.com/TunneldeDev/Tunnelde/commit/9575d9a759ac09fdaa2aeca16a82af6d1be57d6d)) @quyansiyuanwang

### 改进 | Improved

- **ssh:** share remote command encoding ([#305](https://github.com/TunneldeDev/Tunnelde/pull/305), [bbe8daf](https://github.com/TunneldeDev/Tunnelde/commit/bbe8dafcdc4568160bc11d93e4f21a1d73c067e3)) @quyansiyuanwang

### 修复 | Fix

- **files:** retain durable unknown remote editor mutations ([#301](https://github.com/TunneldeDev/Tunnelde/pull/301)) @quyansiyuanwang
- **files:** retain editor replies after foreground timeout ([#303](https://github.com/TunneldeDev/Tunnelde/pull/303)) @quyansiyuanwang
- **commands:** prefer exact titles over overlapping command names ([#304](https://github.com/TunneldeDev/Tunnelde/pull/304), [a56b230](https://github.com/TunneldeDev/Tunnelde/commit/a56b230c1e31d3c2bdb6339fe6aadf2047b9c249)) @quyansiyuanwang
- **files:** fence stale preview panel close effects ([#304](https://github.com/TunneldeDev/Tunnelde/pull/304), [51e315f](https://github.com/TunneldeDev/Tunnelde/commit/51e315fb380586072b7e5c986d22cd7711eda640)) @quyansiyuanwang
- **files:** keep docked preview paths compact ([#304](https://github.com/TunneldeDev/Tunnelde/pull/304), [b0a102e](https://github.com/TunneldeDev/Tunnelde/commit/b0a102ea8f3cd38c6a39b8bfd70c358720e4ab26)) @quyansiyuanwang
- **files:** preserve visible Quick Look content in flex layouts ([#304](https://github.com/TunneldeDev/Tunnelde/pull/304)) @quyansiyuanwang
- **storage:** preserve native save recovery during migration ([#306](https://github.com/TunneldeDev/Tunnelde/pull/306), [e898f06](https://github.com/TunneldeDev/Tunnelde/commit/e898f061cfaceb067bebd738c1c7220976b7a35f)) @quyansiyuanwang
- **files:** reject damaged journal state during checkpoint CAS ([#306](https://github.com/TunneldeDev/Tunnelde/pull/306), [22e3417](https://github.com/TunneldeDev/Tunnelde/commit/22e341763fb26e7164caa66c67daf32212083dc2)) @quyansiyuanwang
- **files:** recheck owner after durable dispatch checkpoint ([#306](https://github.com/TunneldeDev/Tunnelde/pull/306), [c261c71](https://github.com/TunneldeDev/Tunnelde/commit/c261c71e6f63bbc12d9676bb43c3e21fa5d0d40d)) @quyansiyuanwang
- **files:** resolve journal ancestor aliases before SQLite open ([#306](https://github.com/TunneldeDev/Tunnelde/pull/306)) @quyansiyuanwang
- **files:** serialize native recovery credentials on bounded workers ([#307](https://github.com/TunneldeDev/Tunnelde/pull/307), [837f843](https://github.com/TunneldeDev/Tunnelde/commit/837f8433c7a3f4320ef57ecde586d1b90e4048ce)) @quyansiyuanwang
- **files:** distinguish recovery store reload from operation queries ([#307](https://github.com/TunneldeDev/Tunnelde/pull/307)) @quyansiyuanwang
- **files:** preserve native recovery across parent and path aliases ([#308](https://github.com/TunneldeDev/Tunnelde/pull/308), [202ea83](https://github.com/TunneldeDev/Tunnelde/commit/202ea83e07b765acbe054d4796720ee0e56a5383)) @quyansiyuanwang
- **files:** fence legacy mutations against native recovery records ([#308](https://github.com/TunneldeDev/Tunnelde/pull/308), [b2fe694](https://github.com/TunneldeDev/Tunnelde/commit/b2fe694eb080b4e55df0f24095867e0450534933)) @quyansiyuanwang

### 文档 | Docs

- **files:** describe native recovery lifecycle and remaining limits ([#307](https://github.com/TunneldeDev/Tunnelde/pull/307), [7756d0a](https://github.com/TunneldeDev/Tunnelde/commit/7756d0a3bdcbe52a6419c924e83e8494d8eff806)) @quyansiyuanwang
- **files:** describe recovery admission limits in both languages ([#308](https://github.com/TunneldeDev/Tunnelde/pull/308)) @quyansiyuanwang

### 构建 | Build

- **files:** pin native save interoperability fixtures ([#305](https://github.com/TunneldeDev/Tunnelde/pull/305)) @quyansiyuanwang
- **files:** enforce durable save recovery producer checks ([#306](https://github.com/TunneldeDev/Tunnelde/pull/306), [2126b9e](https://github.com/TunneldeDev/Tunnelde/commit/2126b9e8a130cbe64efb78dcdfa68e67adc1e8f5)) @quyansiyuanwang
- **files:** exercise recovery journals on every desktop platform ([#306](https://github.com/TunneldeDev/Tunnelde/pull/306), [c49ae8e](https://github.com/TunneldeDev/Tunnelde/commit/c49ae8e57b87ed04f630a89e3e74f37ce950989c)) @quyansiyuanwang

</details>

### 贡献者 | Contributors

@quyansiyuanwang

## [0.36.0](https://github.com/TunneldeDev/Tunnelde/compare/v0.35.0...v0.36.0) - 2026-11-12

### 更新概览 | Highlights

- **files:** expose committed preview lifecycle and presentation
- **transfers:** separate segment planning from IO orchestration
- **transfers:** size automatic replay windows for the request pipeline
- **files:** separate remote editor staging from lifecycle
- **files:** bound local mutation workers through cancellation

<details open>
<summary>详细变更 | Details (11)</summary>

### 新增 | New

- **files:** expose committed preview lifecycle and presentation ([#294](https://github.com/TunneldeDev/Tunnelde/pull/294), [e1a35e2](https://github.com/TunneldeDev/Tunnelde/commit/e1a35e298d2771a52e08f5a05704abd2351810e9)) @quyansiyuanwang

### 改进 | Improved

- **transfers:** separate segment planning from IO orchestration ([#297](https://github.com/TunneldeDev/Tunnelde/pull/297), [a194e51](https://github.com/TunneldeDev/Tunnelde/commit/a194e51633b8d790f3e39ed23826ba1b4e0f402d)) @quyansiyuanwang
- **transfers:** size automatic replay windows for the request pipeline ([#297](https://github.com/TunneldeDev/Tunnelde/pull/297)) @quyansiyuanwang
- **files:** separate remote editor staging from lifecycle ([#298](https://github.com/TunneldeDev/Tunnelde/pull/298), [426f4dd](https://github.com/TunneldeDev/Tunnelde/commit/426f4ddd7a83db8dc0f86d6185d242b3ff26bf6e)) @quyansiyuanwang

### 修复 | Fix

- **files:** bound local mutation workers through cancellation ([#296](https://github.com/TunneldeDev/Tunnelde/pull/296)) @quyansiyuanwang
- **files:** retain remote editor workers through cancellation ([#298](https://github.com/TunneldeDev/Tunnelde/pull/298)) @quyansiyuanwang
- **files:** fence remote plugin writes at publication admission ([#299](https://github.com/TunneldeDev/Tunnelde/pull/299), [dffb313](https://github.com/TunneldeDev/Tunnelde/commit/dffb31315c023dd466961540e21af027ceef5171)) @quyansiyuanwang
- **plugins:** serialize abandoned tool requests with publication ([#299](https://github.com/TunneldeDev/Tunnelde/pull/299)) @quyansiyuanwang
- **files:** fence local writes with shared publication authorization ([#300](https://github.com/TunneldeDev/Tunnelde/pull/300), [252369b](https://github.com/TunneldeDev/Tunnelde/commit/252369b27d202a421f8ac8da0c100865e6544a02)) @quyansiyuanwang
- **plugins:** retain approved local path aliases through publication ([#300](https://github.com/TunneldeDev/Tunnelde/pull/300)) @quyansiyuanwang

### 构建 | Build

- **plugins:** verify preview contracts against pinned SDK ([#294](https://github.com/TunneldeDev/Tunnelde/pull/294)) @quyansiyuanwang

</details>

### 贡献者 | Contributors

@quyansiyuanwang

## [0.35.0](https://github.com/TunneldeDev/Tunnelde/compare/v0.34.0...v0.35.0) - 2026-11-11

### 更新概览 | Highlights

- **profiles:** expose bounded versioned public content reads
- **profiles:** add owned staged writes and atomic activation
- **profiles:** request native consent for public activation
- **storage:** add confirmed deferred recovery API
- **settings:** distinguish scheduled recovery and review restart intent

<details open>
<summary>详细变更 | Details (32)</summary>

### 新增 | New

- **profiles:** expose bounded versioned public content reads ([#283](https://github.com/TunneldeDev/Tunnelde/pull/283), [8071b5b](https://github.com/TunneldeDev/Tunnelde/commit/8071b5b56e004b908f75bd2677dc99d9c7232e17)) @quyansiyuanwang
- **profiles:** add owned staged writes and atomic activation ([#286](https://github.com/TunneldeDev/Tunnelde/pull/286), [e6440df](https://github.com/TunneldeDev/Tunnelde/commit/e6440dffa70c289134c6a5efc0b0e567d6340e8b)) @quyansiyuanwang
- **profiles:** request native consent for public activation ([#286](https://github.com/TunneldeDev/Tunnelde/pull/286), [34ace3b](https://github.com/TunneldeDev/Tunnelde/commit/34ace3b0fbe1cd69c7ea1b1724f14f8cd2d66a38)) @quyansiyuanwang
- **storage:** add confirmed deferred recovery API ([#288](https://github.com/TunneldeDev/Tunnelde/pull/288), [88ccf5a](https://github.com/TunneldeDev/Tunnelde/commit/88ccf5a7a4433cd627a54b74d1de60288cd16cdd)) @quyansiyuanwang
- **settings:** distinguish scheduled recovery and review restart intent ([#288](https://github.com/TunneldeDev/Tunnelde/pull/288), [0d13150](https://github.com/TunneldeDev/Tunnelde/commit/0d131502c87a2dfc2fb7ee324aa74e210e8bd976)) @quyansiyuanwang
- **plugins:** expose live file browser data and actions ([#290](https://github.com/TunneldeDev/Tunnelde/pull/290), [401d716](https://github.com/TunneldeDev/Tunnelde/commit/401d716a7bd180c83b6c2d226107d6c940c4bcb3)) @quyansiyuanwang
- **files:** add runtime-owned read-only content resources ([#293](https://github.com/TunneldeDev/Tunnelde/pull/293), [f085d7b](https://github.com/TunneldeDev/Tunnelde/commit/f085d7b9c69ccb8f7c0af4cfab6e1eb13067c665)) @quyansiyuanwang

### 改进 | Improved

- **profiles:** decode public profile snapshots outside the database lock ([#283](https://github.com/TunneldeDev/Tunnelde/pull/283)) @quyansiyuanwang

### 修复 | Fix

- **ci:** use explicit Node global in profile SDK consumer ([#283](https://github.com/TunneldeDev/Tunnelde/pull/283), [2b374a3](https://github.com/TunneldeDev/Tunnelde/commit/2b374a3fe354447ffdd00a230c00b42a07dde99e)) @quyansiyuanwang
- **release:** recover platform builds with resilient Linux sources ([#285](https://github.com/TunneldeDev/Tunnelde/pull/285)) @quyansiyuanwang
- **storage:** persist cancellation intent and retain recovery copies ([#287](https://github.com/TunneldeDev/Tunnelde/pull/287), [d918dea](https://github.com/TunneldeDev/Tunnelde/commit/d918dea9520dd297936d42c3eafeb5b5b99fe3ba)) @quyansiyuanwang
- **settings:** expose interrupted storage cancellation and retry ([#287](https://github.com/TunneldeDev/Tunnelde/pull/287), [95e1a85](https://github.com/TunneldeDev/Tunnelde/commit/95e1a856bf522309f45ace2aa4d202a79ce6116f)) @quyansiyuanwang
- **settings:** distinguish cancellation recovery errors from migration failures ([#287](https://github.com/TunneldeDev/Tunnelde/pull/287)) @quyansiyuanwang
- **settings:** keep recovery consent focused on the requested action ([#288](https://github.com/TunneldeDev/Tunnelde/pull/288)) @quyansiyuanwang
- **sftp:** retain uncertain directory creation across retries ([#289](https://github.com/TunneldeDev/Tunnelde/pull/289), [479f067](https://github.com/TunneldeDev/Tunnelde/commit/479f067a0b477c5e5fa225b53c7a45330254d11d)) @quyansiyuanwang
- **tasks:** separate retained directory recovery from transfer progress ([#289](https://github.com/TunneldeDev/Tunnelde/pull/289), [986a478](https://github.com/TunneldeDev/Tunnelde/commit/986a4785022822145e441f806d33f74f86118382)) @quyansiyuanwang
- **tasks:** explain preserved directory contents during recovery ([#289](https://github.com/TunneldeDev/Tunnelde/pull/289)) @quyansiyuanwang
- **files:** bound and safely open native file read workers ([#291](https://github.com/TunneldeDev/Tunnelde/pull/291), [1948a27](https://github.com/TunneldeDev/Tunnelde/commit/1948a27105ce07879723767c463a6a5d9cff5266)) @quyansiyuanwang
- **files:** share bounded explicit-offset remote readers ([#292](https://github.com/TunneldeDev/Tunnelde/pull/292), [cfc8fdf](https://github.com/TunneldeDev/Tunnelde/commit/cfc8fdfdace21d4a38242df9b690074f172d6be6)) @quyansiyuanwang

### 文档 | Docs

- **transfers:** explain retained directory recovery ([#289](https://github.com/TunneldeDev/Tunnelde/pull/289), [a64438e](https://github.com/TunneldeDev/Tunnelde/commit/a64438efa11bc0098fd6a2255c945199bf8999d8)) @quyansiyuanwang
- **plugins:** describe revision-bound browser operations ([#290](https://github.com/TunneldeDev/Tunnelde/pull/290), [bd449c3](https://github.com/TunneldeDev/Tunnelde/commit/bd449c3a9e0abb987780e3279173afad8b7c47dd)) @quyansiyuanwang
- **files:** describe read budgets and cancellation limits ([#291](https://github.com/TunneldeDev/Tunnelde/pull/291), [d5c9448](https://github.com/TunneldeDev/Tunnelde/commit/d5c94482edc6265ae11db4cf4d05cdf206eca494)) @quyansiyuanwang
- **files:** describe remote read ownership and deadlines ([#292](https://github.com/TunneldeDev/Tunnelde/pull/292)) @quyansiyuanwang

### 构建 | Build

- **transfers:** measure throttling after opening SFTP handles ([#283](https://github.com/TunneldeDev/Tunnelde/pull/283), [aa66b61](https://github.com/TunneldeDev/Tunnelde/commit/aa66b61cbb628977dcd40013ccd0b0e527fb0806)) @quyansiyuanwang
- **profiles:** check native writes against the SDK contract ([#286](https://github.com/TunneldeDev/Tunnelde/pull/286)) @quyansiyuanwang
- **storage:** check native recovery with pinned SDK ([#288](https://github.com/TunneldeDev/Tunnelde/pull/288), [c46c5c5](https://github.com/TunneldeDev/Tunnelde/commit/c46c5c50d596aff3b7cdf1a84a7817fc9defeb37)) @quyansiyuanwang
- **plugins:** cover browser discovery and historical exports ([#290](https://github.com/TunneldeDev/Tunnelde/pull/290), [6392d89](https://github.com/TunneldeDev/Tunnelde/commit/6392d89e60777cbe6c32991ad45279f869eaebf9)) @quyansiyuanwang
- **plugins:** verify real file browser responses with pinned SDK ([#290](https://github.com/TunneldeDev/Tunnelde/pull/290)) @quyansiyuanwang
- **files:** exercise native readers on Windows and macOS ([#291](https://github.com/TunneldeDev/Tunnelde/pull/291), [03e16b0](https://github.com/TunneldeDev/Tunnelde/commit/03e16b0fb604402cc7e6a11933cac5518f46b750)) @quyansiyuanwang
- **files:** bound the FIFO replacement regression probe ([#291](https://github.com/TunneldeDev/Tunnelde/pull/291)) @quyansiyuanwang
- **files:** verify content contracts across host and SDK ([#293](https://github.com/TunneldeDev/Tunnelde/pull/293), [4301a01](https://github.com/TunneldeDev/Tunnelde/commit/4301a011d5bf505b6d800fd30704ae8fea46d67f)) @quyansiyuanwang
- **files:** record additive content types in compatibility contract ([#293](https://github.com/TunneldeDev/Tunnelde/pull/293)) @quyansiyuanwang

</details>

### 贡献者 | Contributors

@quyansiyuanwang

## [0.34.0](https://github.com/TunneldeDev/Tunnelde/compare/v0.33.0...v0.34.0) - 2026-11-11

### 更新概览 | Highlights

- **plugins:** freeze notification and confirmation v1 contracts
- **plugins:** freeze advisory event publication v1 contract
- **plugins:** add host decorations and shared extension discovery
- **plugins:** serve approved frontend assets with revocable leases
- **plugins:** host trusted React views and frontend commands

<details open>
<summary>详细变更 | Details (134)</summary>

### 新增 | New

- **plugins:** freeze notification and confirmation v1 contracts ([#202](https://github.com/TunneldeDev/Tunnelde/pull/202)) @quyansiyuanwang
- **plugins:** freeze advisory event publication v1 contract ([#211](https://github.com/TunneldeDev/Tunnelde/pull/211)) @quyansiyuanwang
- **plugins:** add host decorations and shared extension discovery ([#216](https://github.com/TunneldeDev/Tunnelde/pull/216)) @quyansiyuanwang
- **plugins:** serve approved frontend assets with revocable leases ([#220](https://github.com/TunneldeDev/Tunnelde/pull/220), [7ef9cb3](https://github.com/TunneldeDev/Tunnelde/commit/7ef9cb3cd2aed1c71a9ca3e7cbb99a411c31c9f9)) @quyansiyuanwang
- **plugins:** host trusted React views and frontend commands ([#220](https://github.com/TunneldeDev/Tunnelde/pull/220), [b903deb](https://github.com/TunneldeDev/Tunnelde/commit/b903deb64b0ece8e84d2fbcf0d579256e4688ab6)) @quyansiyuanwang
- **plugins:** contribute host menu commands through shared context dispatch ([#221](https://github.com/TunneldeDev/Tunnelde/pull/221)) @quyansiyuanwang
- **plugins:** retain live workspace surfaces in user-selected UI providers ([#223](https://github.com/TunneldeDev/Tunnelde/pull/223)) @quyansiyuanwang
- **plugins:** add revisioned host metadata fields ([#224](https://github.com/TunneldeDev/Tunnelde/pull/224)) @quyansiyuanwang
- **hosts:** add configurable table columns and plugin contributions ([#225](https://github.com/TunneldeDev/Tunnelde/pull/225)) @quyansiyuanwang
- **plugins:** transfer SSH connection ownership with native consent ([#229](https://github.com/TunneldeDev/Tunnelde/pull/229)) @quyansiyuanwang
- **plugins:** integrate runtime host discovery sources ([#230](https://github.com/TunneldeDev/Tunnelde/pull/230)) @quyansiyuanwang
- **plugins:** compose file browser providers with host panes ([#232](https://github.com/TunneldeDev/Tunnelde/pull/232)) @quyansiyuanwang
- **plugins:** expose the live terminal through trusted UI providers ([#234](https://github.com/TunneldeDev/Tunnelde/pull/234), [339a314](https://github.com/TunneldeDev/Tunnelde/commit/339a31423d43df6201620e61c7ea0881bf5729e8)) @quyansiyuanwang
- **plugins:** expose revisioned command history providers ([#236](https://github.com/TunneldeDev/Tunnelde/pull/236), [bbb6831](https://github.com/TunneldeDev/Tunnelde/commit/bbb68311496806fb537d276d26d657f7e1a37f5d)) @quyansiyuanwang
- **forwarding:** authorize provider scopes and independent SSH admission ([#243](https://github.com/TunneldeDev/Tunnelde/pull/243), [2705a99](https://github.com/TunneldeDev/Tunnelde/commit/2705a99ae5ce52cde6ca76bae96242dc5c44c5c4)) @quyansiyuanwang
- **plugins:** compose forwarding views with bounded domain contracts ([#243](https://github.com/TunneldeDev/Tunnelde/pull/243)) @quyansiyuanwang
- **monitor:** expose shared charts through domain UI contracts ([#244](https://github.com/TunneldeDev/Tunnelde/pull/244)) @quyansiyuanwang
- **plugins:** expose owned tasks and composable task views ([#245](https://github.com/TunneldeDev/Tunnelde/pull/245)) @quyansiyuanwang
- **plugins:** expose confirmed process manager UI providers ([#246](https://github.com/TunneldeDev/Tunnelde/pull/246)) @quyansiyuanwang
- **search:** separate quick access services and bounded UI providers ([#247](https://github.com/TunneldeDev/Tunnelde/pull/247)) @quyansiyuanwang
- **settings:** add grouped preferences schema and revisioned updates ([#249](https://github.com/TunneldeDev/Tunnelde/pull/249)) @quyansiyuanwang
- **settings:** support authorized preference form providers ([#250](https://github.com/TunneldeDev/Tunnelde/pull/250)) @quyansiyuanwang
- **plugins:** add owned configuration schemas and recovery ([#251](https://github.com/TunneldeDev/Tunnelde/pull/251)) @quyansiyuanwang
- **plugins:** expose owned runtime resource lifecycle ([#252](https://github.com/TunneldeDev/Tunnelde/pull/252)) @quyansiyuanwang
- **plugins:** prepare bounded dependency activation plans ([#254](https://github.com/TunneldeDev/Tunnelde/pull/254), [b768405](https://github.com/TunneldeDev/Tunnelde/commit/b768405138093c23deb960ccfe265144e2e9a5b0)) @quyansiyuanwang
- **plugins:** bind activation readiness and scoped retirement ([#254](https://github.com/TunneldeDev/Tunnelde/pull/254), [5ef8518](https://github.com/TunneldeDev/Tunnelde/commit/5ef851865f7a6047781f2505311c04a12391f488)) @quyansiyuanwang
- **plugins:** coordinate shared startup through frontend readiness ([#255](https://github.com/TunneldeDev/Tunnelde/pull/255)) @quyansiyuanwang
- **plugins:** activate reviewed dependency graphs ([#257](https://github.com/TunneldeDev/Tunnelde/pull/257), [f9abb9b](https://github.com/TunneldeDev/Tunnelde/commit/f9abb9b1183ca05f4a6aa0760c67c19da2a95320)) @quyansiyuanwang
- **runners:** bind recovery to captured SSH destinations ([#259](https://github.com/TunneldeDev/Tunnelde/pull/259), [6328b11](https://github.com/TunneldeDev/Tunnelde/commit/6328b11aa54b01a36ce77f1feefe196d293b512a)) @quyansiyuanwang
- **plugins:** add native remote task recovery controls ([#259](https://github.com/TunneldeDev/Tunnelde/pull/259), [743bcb5](https://github.com/TunneldeDev/Tunnelde/commit/743bcb5d28e0895d6ab81da56aa8b90ee3c79d67)) @quyansiyuanwang
- **plugins:** compose UI resource scopes with shared budgets ([#260](https://github.com/TunneldeDev/Tunnelde/pull/260), [eab0a18](https://github.com/TunneldeDev/Tunnelde/commit/eab0a1809bd4cf1231fd334b77b1e6b81b841e13)) @quyansiyuanwang
- **plugins:** bind UI resource scopes to committed view instances ([#261](https://github.com/TunneldeDev/Tunnelde/pull/261), [1df7a6e](https://github.com/TunneldeDev/Tunnelde/commit/1df7a6ea38cd053e485dbc9d048a712e0d9cd25f)) @quyansiyuanwang
- **plugins:** identify exact owned resources by domain reference ([#262](https://github.com/TunneldeDev/Tunnelde/pull/262)) @quyansiyuanwang
- **runners:** open recovery files on the verified original host ([#265](https://github.com/TunneldeDev/Tunnelde/pull/265), [11a90b1](https://github.com/TunneldeDev/Tunnelde/commit/11a90b1e03eeea47c7e8854ac1d406eb60d46824)) @quyansiyuanwang
- **runners:** inspect explicitly selected helper capabilities ([#266](https://github.com/TunneldeDev/Tunnelde/pull/266), [5ae6cf2](https://github.com/TunneldeDev/Tunnelde/commit/5ae6cf2a3767c817f7f65c191fc522b32c2f48c4)) @quyansiyuanwang
- **runners:** negotiate initialized remote configuration ([#270](https://github.com/TunneldeDev/Tunnelde/pull/270), [fc6dcbb](https://github.com/TunneldeDev/Tunnelde/commit/fc6dcbb61ea2c005886a72aa2761fd131ccec7c9)) @quyansiyuanwang
- **settings:** add conditional public preference observation ([#272](https://github.com/TunneldeDev/Tunnelde/pull/272), [9e28b8a](https://github.com/TunneldeDev/Tunnelde/commit/9e28b8a03b7e0a279307e71b23c9c2a219d928fd)) @quyansiyuanwang
- **editor:** expose versioned buffer data APIs ([#273](https://github.com/TunneldeDev/Tunnelde/pull/273), [e923fc9](https://github.com/TunneldeDev/Tunnelde/commit/e923fc932328b7f6bb8476de7ea0e8f9c4803903)) @quyansiyuanwang
- **runners:** expose task-bound artifact metadata observation ([#274](https://github.com/TunneldeDev/Tunnelde/pull/274), [089c81f](https://github.com/TunneldeDev/Tunnelde/commit/089c81f947249a605ddd003414304d2fb59f8e6f)) @quyansiyuanwang
- **profiles:** add transactional metadata observations ([#276](https://github.com/TunneldeDev/Tunnelde/pull/276), [dd29485](https://github.com/TunneldeDev/Tunnelde/commit/dd29485851d829330902614986353201bce32976)) @quyansiyuanwang
- **plugins:** add scoped storage observation contracts ([#277](https://github.com/TunneldeDev/Tunnelde/pull/277), [75d6a5c](https://github.com/TunneldeDev/Tunnelde/commit/75d6a5c78ac011609ed7c5205f35ada435c97aea)) @quyansiyuanwang
- **storage:** fence plugin-managed location plans ([#279](https://github.com/TunneldeDev/Tunnelde/pull/279), [e87a9ee](https://github.com/TunneldeDev/Tunnelde/commit/e87a9ee0e0978376a0388f1bc6b4a341fac58b98)) @quyansiyuanwang
- **plugins:** review and expose host storage plans ([#279](https://github.com/TunneldeDev/Tunnelde/pull/279), [de08d1c](https://github.com/TunneldeDev/Tunnelde/commit/de08d1ccf4809dc28d2afd24340c166a1655693e)) @quyansiyuanwang
- **logging:** expose permission-scoped persisted log pages ([#281](https://github.com/TunneldeDev/Tunnelde/pull/281), [fa51d2f](https://github.com/TunneldeDev/Tunnelde/commit/fa51d2f578e29b564fe28c1e57c2e08c913154bc)) @quyansiyuanwang

### 改进 | Improved

- **transfers:** buffer local segment IO without changing recovery windows ([#214](https://github.com/TunneldeDev/Tunnelde/pull/214)) @quyansiyuanwang
- **hosts:** share validated domain operations across transports ([#217](https://github.com/TunneldeDev/Tunnelde/pull/217)) @quyansiyuanwang
- **extensions:** own cancellable work and bounded resource cleanup ([#219](https://github.com/TunneldeDev/Tunnelde/pull/219)) @quyansiyuanwang
- **history:** share committed mutations across native and plugin callers ([#235](https://github.com/TunneldeDev/Tunnelde/pull/235)) @quyansiyuanwang
- **forwarding:** share domain contracts and committed state changes ([#237](https://github.com/TunneldeDev/Tunnelde/pull/237), [a2a8506](https://github.com/TunneldeDev/Tunnelde/commit/a2a8506bf94712d18e47cd9ccc32dc3f79b46bd0)) @quyansiyuanwang
- **forwarding:** keep storage orchestration out of SSH transport ([#237](https://github.com/TunneldeDev/Tunnelde/pull/237)) @quyansiyuanwang
- **plugins:** separate public UI contracts by domain ([#238](https://github.com/TunneldeDev/Tunnelde/pull/238)) @quyansiyuanwang
- **plugins:** organize RPC discovery by domain ([#239](https://github.com/TunneldeDev/Tunnelde/pull/239), [0224cdd](https://github.com/TunneldeDev/Tunnelde/commit/0224cdde9a52e624834196a9fc2ea8945709ce86)) @quyansiyuanwang
- **plugins:** split RPC adapters by domain ([#240](https://github.com/TunneldeDev/Tunnelde/pull/240), [5bbface](https://github.com/TunneldeDev/Tunnelde/commit/5bbface81798873403c939271dae0335810f807b)) @quyansiyuanwang
- **extensions:** organize UI adapters by domain ([#242](https://github.com/TunneldeDev/Tunnelde/pull/242), [ba59e56](https://github.com/TunneldeDev/Tunnelde/commit/ba59e56ac4c742c0ee47be0ba7175262f9bf918b)) @quyansiyuanwang
- **forwarding:** separate model, state, actions and views ([#242](https://github.com/TunneldeDev/Tunnelde/pull/242)) @quyansiyuanwang
- **plugins:** separate activation engine lifecycle ([#254](https://github.com/TunneldeDev/Tunnelde/pull/254), [8964077](https://github.com/TunneldeDev/Tunnelde/commit/8964077141b475822c9aec28ca4a6ba2f3cbbf18)) @quyansiyuanwang

### 修复 | Fix

- **plugins:** cancel frontend requests before delayed UI opens ([#202](https://github.com/TunneldeDev/Tunnelde/pull/202), [eae0289](https://github.com/TunneldeDev/Tunnelde/commit/eae02899c57f04c738f655b07287e8fad717b1e3)) @quyansiyuanwang
- **transfers:** interrupt cancelled preparation without abandoning mutations ([#209](https://github.com/TunneldeDev/Tunnelde/pull/209)) @quyansiyuanwang
- **deps:** bump russh from 0.65.0 to 0.65.1 in /src-tauri ([#205](https://github.com/TunneldeDev/Tunnelde/pull/205))
- **deps:** bump flate2 from 1.1.10 to 1.1.11 in /src-tauri ([#204](https://github.com/TunneldeDev/Tunnelde/pull/204))
- **deps:** update translation and icon dependencies together ([#210](https://github.com/TunneldeDev/Tunnelde/pull/210)) @quyansiyuanwang
- **plugins:** escape Unicode separators for historical SDK readers ([#211](https://github.com/TunneldeDev/Tunnelde/pull/211), [e8a1314](https://github.com/TunneldeDev/Tunnelde/commit/e8a1314172a7e01e0b3c1128b98606bb3738135c)) @quyansiyuanwang
- **transfers:** retain unacknowledged staging directory creation ([#212](https://github.com/TunneldeDev/Tunnelde/pull/212)) @quyansiyuanwang
- **transfers:** settle pending directory creation after cancellation ([#213](https://github.com/TunneldeDev/Tunnelde/pull/213)) @quyansiyuanwang
- **transfers:** sample payload regions without SFTP prefetch ([#215](https://github.com/TunneldeDev/Tunnelde/pull/215)) @quyansiyuanwang
- **search:** require at-prefixed qualifiers throughout the workbench ([#218](https://github.com/TunneldeDev/Tunnelde/pull/218), [712c983](https://github.com/TunneldeDev/Tunnelde/commit/712c9839276de8926cd2979dec2fda9a1b929dfa)) @quyansiyuanwang
- **plugins:** fence frontend activation retirement and snapshot generations ([#220](https://github.com/TunneldeDev/Tunnelde/pull/220)) @quyansiyuanwang
- **search:** preserve literal fields when editing shortcut filters ([#222](https://github.com/TunneldeDev/Tunnelde/pull/222)) @quyansiyuanwang
- **plugins:** release SSH connections with runtime leases ([#226](https://github.com/TunneldeDev/Tunnelde/pull/226)) @quyansiyuanwang
- **plugins:** release tool client SSH connections on cancellation ([#227](https://github.com/TunneldeDev/Tunnelde/pull/227)) @quyansiyuanwang
- **ssh:** keep background connection cleanup notifications quiet ([#228](https://github.com/TunneldeDev/Tunnelde/pull/228)) @quyansiyuanwang
- **shortcuts:** isolate shortcut recording from command routing ([#231](https://github.com/TunneldeDev/Tunnelde/pull/231)) @quyansiyuanwang
- **terminal:** negotiate enhanced keyboard input through xterm ([#233](https://github.com/TunneldeDev/Tunnelde/pull/233), [423d429](https://github.com/TunneldeDev/Tunnelde/commit/423d42940e4a18382ffbdd8a5e93669827e0f852)) @quyansiyuanwang
- **terminal:** hide the obsolete viewport after engine upgrade ([#233](https://github.com/TunneldeDev/Tunnelde/pull/233)) @quyansiyuanwang
- **plugins:** clarify interface provider selection and recovery messages ([#234](https://github.com/TunneldeDev/Tunnelde/pull/234)) @quyansiyuanwang
- **history:** use the shared error color token ([#236](https://github.com/TunneldeDev/Tunnelde/pull/236)) @quyansiyuanwang
- **tests:** qualify Unix file read timeout ([#240](https://github.com/TunneldeDev/Tunnelde/pull/240)) @quyansiyuanwang
- **forwarding:** reject stale rule edits and confirmations ([#241](https://github.com/TunneldeDev/Tunnelde/pull/241), [7e5b9d3](https://github.com/TunneldeDev/Tunnelde/commit/7e5b9d30e436fc25c728a7d6070ec9c89f9c19a9)) @quyansiyuanwang
- **forwarding:** retire pending editor actions on host changes ([#241](https://github.com/TunneldeDev/Tunnelde/pull/241)) @quyansiyuanwang
- **monitor:** retire samples after the last view closes ([#244](https://github.com/TunneldeDev/Tunnelde/pull/244), [e949a75](https://github.com/TunneldeDev/Tunnelde/commit/e949a75e4a38d92a27aa28d4c95c642612e6c2bb)) @quyansiyuanwang
- **tasks:** scope source registration and serialize task actions ([#245](https://github.com/TunneldeDev/Tunnelde/pull/245), [dfa9ad6](https://github.com/TunneldeDev/Tunnelde/commit/dfa9ad6753cf2ab19337fe2e5471a458d4d13355)) @quyansiyuanwang
- **monitor:** share process sampling across view lifetimes ([#246](https://github.com/TunneldeDev/Tunnelde/pull/246), [ad744e0](https://github.com/TunneldeDev/Tunnelde/commit/ad744e0c86aee55e9db2e1e00ee51b90a8b6173a)) @quyansiyuanwang
- **plugins:** revalidate contributed actions after activation and consent ([#247](https://github.com/TunneldeDev/Tunnelde/pull/247), [64f82fc](https://github.com/TunneldeDev/Tunnelde/commit/64f82fc33fb3f35d16215cb5fedc5310914c076e)) @quyansiyuanwang
- **settings:** serialize preference and updater metadata commits ([#248](https://github.com/TunneldeDev/Tunnelde/pull/248), [d29e1d2](https://github.com/TunneldeDev/Tunnelde/commit/d29e1d2e1f18c36cde063a13eb2ec23eee251643)) @quyansiyuanwang
- **profiles:** preserve all portable shortcut and terminal settings ([#248](https://github.com/TunneldeDev/Tunnelde/pull/248)) @quyansiyuanwang
- **updates:** reveal diagnostics from notification actions ([#253](https://github.com/TunneldeDev/Tunnelde/pull/253)) @quyansiyuanwang
- **plugins:** cancel activation without reviving stale starts ([#254](https://github.com/TunneldeDev/Tunnelde/pull/254), [b42385c](https://github.com/TunneldeDev/Tunnelde/commit/b42385c4f5bb28051013067b5bb71074230be56a)) @quyansiyuanwang
- **plugins:** bind queued commands to their running instance ([#254](https://github.com/TunneldeDev/Tunnelde/pull/254), [86a6ca8](https://github.com/TunneldeDev/Tunnelde/commit/86a6ca881ccffaa4e59ed173bddcbc10302fe7e1)) @quyansiyuanwang
- **plugins:** bind view requests and wait for runtime readiness ([#254](https://github.com/TunneldeDev/Tunnelde/pull/254)) @quyansiyuanwang
- **plugins:** preflight package and runtime before activation ([#256](https://github.com/TunneldeDev/Tunnelde/pull/256)) @quyansiyuanwang
- **plugins:** allow supported dependency manifests in install UI ([#257](https://github.com/TunneldeDev/Tunnelde/pull/257)) @quyansiyuanwang
- **runners:** persist cancellation and recover remote stops without global blocking ([#258](https://github.com/TunneldeDev/Tunnelde/pull/258)) @quyansiyuanwang
- **runners:** keep native recovery confirmation details readable ([#259](https://github.com/TunneldeDev/Tunnelde/pull/259), [3adb3d8](https://github.com/TunneldeDev/Tunnelde/commit/3adb3d8bc4a825d9af9ac4e93ef22fd7cac66f65)) @quyansiyuanwang
- **runners:** preserve remote recovery command errors ([#259](https://github.com/TunneldeDev/Tunnelde/pull/259)) @quyansiyuanwang
- **plugins:** release scope capacity on invalid cancellation signals ([#260](https://github.com/TunneldeDev/Tunnelde/pull/260)) @quyansiyuanwang
- **plugins:** retain native surfaces until provider scopes are ready ([#261](https://github.com/TunneldeDev/Tunnelde/pull/261)) @quyansiyuanwang
- **plugins:** journal remote deployments before mutations ([#263](https://github.com/TunneldeDev/Tunnelde/pull/263), [2e50e2f](https://github.com/TunneldeDev/Tunnelde/commit/2e50e2ff0c1d472d1d25c7b46212cb9c6146da5f)) @quyansiyuanwang
- **recovery:** distinguish deployment directories in summaries ([#263](https://github.com/TunneldeDev/Tunnelde/pull/263)) @quyansiyuanwang
- **plugins:** journal configuration writes before runner launch ([#264](https://github.com/TunneldeDev/Tunnelde/pull/264), [c995108](https://github.com/TunneldeDev/Tunnelde/commit/c995108a56ef6c7c1de82e8309e71aa1446c31b1)) @quyansiyuanwang
- **recovery:** surface unfinished config writes in summaries ([#264](https://github.com/TunneldeDev/Tunnelde/pull/264)) @quyansiyuanwang
- **runners:** synchronize accepted sessions before opening file panes ([#265](https://github.com/TunneldeDev/Tunnelde/pull/265)) @quyansiyuanwang
- **hosts:** fill the allocated sidebar and docked panel ([#269](https://github.com/TunneldeDev/Tunnelde/pull/269), [c1e158c](https://github.com/TunneldeDev/Tunnelde/commit/c1e158c33c75c7221582a914a71c7079cb745c2a)) @quyansiyuanwang
- **files:** anchor focus and drop frames to the scroll viewport ([#269](https://github.com/TunneldeDev/Tunnelde/pull/269)) @quyansiyuanwang
- **runners:** reconcile uncertain launches with durable admission ([#271](https://github.com/TunneldeDev/Tunnelde/pull/271), [66ad81f](https://github.com/TunneldeDev/Tunnelde/commit/66ad81f65fc729e33999cb4c2f236d97c7a95748)) @quyansiyuanwang
- **editor:** reject buffers without an open editor tab ([#273](https://github.com/TunneldeDev/Tunnelde/pull/273), [adba274](https://github.com/TunneldeDev/Tunnelde/commit/adba274291d7b0072a3de882f7af3db064e4198c)) @quyansiyuanwang
- **editor:** retain undo within the buffer size budget ([#273](https://github.com/TunneldeDev/Tunnelde/pull/273)) @quyansiyuanwang
- **files:** share preview read lifetimes and release failed tickets ([#275](https://github.com/TunneldeDev/Tunnelde/pull/275), [1b66558](https://github.com/TunneldeDev/Tunnelde/commit/1b6655830f2554c6e2f53639f0720bc861ec8512)) @quyansiyuanwang
- **editor:** fence saves and reconnect reads by document lifetime ([#275](https://github.com/TunneldeDev/Tunnelde/pull/275)) @quyansiyuanwang
- **profiles:** validate storage and preserve contract compatibility ([#276](https://github.com/TunneldeDev/Tunnelde/pull/276)) @quyansiyuanwang
- **plugins:** propagate cancellation to owned host requests ([#278](https://github.com/TunneldeDev/Tunnelde/pull/278), [3018441](https://github.com/TunneldeDev/Tunnelde/commit/301844175ac08b9727a6739ccb0fc4f8c9418427)) @quyansiyuanwang
- **storage:** bound policy commits and redact review errors ([#279](https://github.com/TunneldeDev/Tunnelde/pull/279)) @quyansiyuanwang
- **storage:** reconcile plans after event bridge recovery ([#280](https://github.com/TunneldeDev/Tunnelde/pull/280)) @quyansiyuanwang
- **logging:** bound current-log directory selection ([#281](https://github.com/TunneldeDev/Tunnelde/pull/281), [d001b5b](https://github.com/TunneldeDev/Tunnelde/commit/d001b5bb215eef97d73bf44578ccc190b303c58d)) @quyansiyuanwang
- **ci:** recover dependency installation from Ubuntu mirror failures ([#281](https://github.com/TunneldeDev/Tunnelde/pull/281), [c4cdad0](https://github.com/TunneldeDev/Tunnelde/commit/c4cdad0c0627f369f45da645e70a054807f26f74)) @quyansiyuanwang
- **logging:** normalize timestamps for SDK consumers ([#281](https://github.com/TunneldeDev/Tunnelde/pull/281)) @quyansiyuanwang
- **settings:** apply profiles atomically from saved revisions ([#282](https://github.com/TunneldeDev/Tunnelde/pull/282), [1dca8b5](https://github.com/TunneldeDev/Tunnelde/commit/1dca8b5445101a0c0a5740d26fc83113b48cdc0b)) @quyansiyuanwang
- **settings:** synchronize profile selection and queued activation ([#282](https://github.com/TunneldeDev/Tunnelde/pull/282), [cd2b41e](https://github.com/TunneldeDev/Tunnelde/commit/cd2b41eba30b0a3a04798c02e9ee6cfbbd3f355a)) @quyansiyuanwang
- **settings:** preserve newer events when activation responses arrive late ([#282](https://github.com/TunneldeDev/Tunnelde/pull/282)) @quyansiyuanwang

### 文档 | Docs

- **search:** update bilingual README filter examples ([#218](https://github.com/TunneldeDev/Tunnelde/pull/218), [c106584](https://github.com/TunneldeDev/Tunnelde/commit/c106584f6cb39be185f6cc14c2ac8bd55b094cb0)) @quyansiyuanwang
- **plugins:** define the evidence required for a 1.0 release ([#236](https://github.com/TunneldeDev/Tunnelde/pull/236), [dd93c42](https://github.com/TunneldeDev/Tunnelde/commit/dd93c42fdef8f682e6db4a275f770a976d80aba0)) @quyansiyuanwang
- **plugins:** align domain organization status with implementation ([#241](https://github.com/TunneldeDev/Tunnelde/pull/241), [f005650](https://github.com/TunneldeDev/Tunnelde/commit/f005650a43efc6cfcce36f0dca93d08704a969d9)) @quyansiyuanwang
- organize guides by language and purpose ([#267](https://github.com/TunneldeDev/Tunnelde/pull/267)) @quyansiyuanwang

### 构建 | Build

- **policy:** support explicit PR checks during event outages ([#218](https://github.com/TunneldeDev/Tunnelde/pull/218)) @quyansiyuanwang
- **plugins:** pin the domain-aware SDK catalogue reader ([#239](https://github.com/TunneldeDev/Tunnelde/pull/239)) @quyansiyuanwang
- **runners:** verify discovery against pinned helper generations ([#266](https://github.com/TunneldeDev/Tunnelde/pull/266)) @quyansiyuanwang
- **runners:** pin the reviewed initialized helper ([#270](https://github.com/TunneldeDev/Tunnelde/pull/270)) @quyansiyuanwang
- **runners:** verify fenced helper receipts across repositories ([#271](https://github.com/TunneldeDev/Tunnelde/pull/271)) @quyansiyuanwang
- **settings:** register additive observation contracts ([#272](https://github.com/TunneldeDev/Tunnelde/pull/272)) @quyansiyuanwang
- **runners:** verify current and historical artifact protocols ([#274](https://github.com/TunneldeDev/Tunnelde/pull/274)) @quyansiyuanwang
- **profiles:** verify native output against the pinned SDK ([#276](https://github.com/TunneldeDev/Tunnelde/pull/276), [d61d758](https://github.com/TunneldeDev/Tunnelde/commit/d61d7580d7b41308ccd6715482491374592daf8d)) @quyansiyuanwang
- **plugins:** verify native storage with pinned SDK consumer ([#277](https://github.com/TunneldeDev/Tunnelde/pull/277)) @quyansiyuanwang
- **plugins:** pin cancellable SDK transport in native CI ([#278](https://github.com/TunneldeDev/Tunnelde/pull/278)) @quyansiyuanwang
- **logging:** distinguish native wire and decoded decimal budgets ([#281](https://github.com/TunneldeDev/Tunnelde/pull/281), [18d34ea](https://github.com/TunneldeDev/Tunnelde/commit/18d34eaf8db44f6f9fcb73fc33b78b5a7cf5e756)) @quyansiyuanwang

### 其他 | Other

- remove duplicate legacy plugin example ([#268](https://github.com/TunneldeDev/Tunnelde/pull/268)) @quyansiyuanwang

</details>

### 贡献者 | Contributors

@quyansiyuanwang

## [0.33.0](https://github.com/TunneldeDev/Tunnelde/compare/v0.32.0...v0.33.0) - 2026-11-09

### 更新概览 | Highlights

- **plugins:** stabilize detached workspace snapshots
- **files:** resume guarded local directory moves
- **plugins:** freeze tab bar contribution v1 contracts
- **search:** unify workbench qualifiers and filter presets
- **logging:** share structured local diagnostics with plugins and features

<details open>
<summary>详细变更 | Details (32)</summary>

### 新增 | New

- **plugins:** stabilize detached workspace snapshots ([#181](https://github.com/TunneldeDev/Tunnelde/pull/181)) @quyansiyuanwang
- **files:** resume guarded local directory moves ([#183](https://github.com/TunneldeDev/Tunnelde/pull/183), [0983814](https://github.com/TunneldeDev/Tunnelde/commit/098381401dc72be9d5e094cc328a67bd15d370af)) @quyansiyuanwang
- **plugins:** freeze tab bar contribution v1 contracts ([#185](https://github.com/TunneldeDev/Tunnelde/pull/185)) @quyansiyuanwang
- **search:** unify workbench qualifiers and filter presets ([#193](https://github.com/TunneldeDev/Tunnelde/pull/193)) @quyansiyuanwang
- **logging:** share structured local diagnostics with plugins and features ([#196](https://github.com/TunneldeDev/Tunnelde/pull/196), [c5a44c2](https://github.com/TunneldeDev/Tunnelde/commit/c5a44c2371f0ec6a88be5775f18a6c286a5a9353)) @quyansiyuanwang
- **shortcuts:** add ordered dispatch and per-binding propagation ([#199](https://github.com/TunneldeDev/Tunnelde/pull/199), [5039b9c](https://github.com/TunneldeDev/Tunnelde/commit/5039b9cd0a94fbcddad4d0ce49c7e1044c5f6e87)) @quyansiyuanwang
- **plugins:** freeze the structured logging v1 contract ([#200](https://github.com/TunneldeDev/Tunnelde/pull/200)) @quyansiyuanwang

### 改进 | Improved

- **plugins:** suspend hidden chat polling and rendering ([#180](https://github.com/TunneldeDev/Tunnelde/pull/180)) @quyansiyuanwang
- **workspace:** share controlled panel layouts and splitters ([#194](https://github.com/TunneldeDev/Tunnelde/pull/194)) @quyansiyuanwang

### 修复 | Fix

- **plugins:** drain and clean journaled background transfers ([#174](https://github.com/TunneldeDev/Tunnelde/pull/174)) @quyansiyuanwang
- **ssh:** close active channels when disconnecting sessions ([#176](https://github.com/TunneldeDev/Tunnelde/pull/176)) @quyansiyuanwang
- **hosts:** show nested groups and reveal matching hosts ([#177](https://github.com/TunneldeDev/Tunnelde/pull/177)) @quyansiyuanwang
- **files:** protect copy commands with journaled background tasks ([#178](https://github.com/TunneldeDev/Tunnelde/pull/178)) @quyansiyuanwang
- **plugins:** keep commands and views responsive during async work ([#179](https://github.com/TunneldeDev/Tunnelde/pull/179)) @quyansiyuanwang
- **preview:** preserve open documents when changing language ([#182](https://github.com/TunneldeDev/Tunnelde/pull/182)) @quyansiyuanwang
- **files:** retain sources with Windows named streams ([#183](https://github.com/TunneldeDev/Tunnelde/pull/183)) @quyansiyuanwang
- **transfer:** separate server copy from network limits ([#184](https://github.com/TunneldeDev/Tunnelde/pull/184)) @quyansiyuanwang
- **plugins:** project plugin tabs to public contribution kinds ([#185](https://github.com/TunneldeDev/Tunnelde/pull/185), [66152c3](https://github.com/TunneldeDev/Tunnelde/commit/66152c3e556db36d1d6f6d0759b4add5d12008e7)) @quyansiyuanwang
- **settings:** preserve exports when writing profiles fails ([#186](https://github.com/TunneldeDev/Tunnelde/pull/186)) @quyansiyuanwang
- **shortcuts:** preserve queued conflicts during resolution ([#187](https://github.com/TunneldeDev/Tunnelde/pull/187)) @quyansiyuanwang
- **plugins:** bind chat task recovery to its original run ([#188](https://github.com/TunneldeDev/Tunnelde/pull/188)) @quyansiyuanwang
- **plugins:** compact chat task history and readable approvals ([#189](https://github.com/TunneldeDev/Tunnelde/pull/189)) @quyansiyuanwang
- **plugins:** retain task failure details in output snapshots ([#190](https://github.com/TunneldeDev/Tunnelde/pull/190)) @quyansiyuanwang
- **files:** merge remote directories with server-side moves ([#191](https://github.com/TunneldeDev/Tunnelde/pull/191)) @quyansiyuanwang
- **workspace:** keep docked panels collapsed when closing panes ([#192](https://github.com/TunneldeDev/Tunnelde/pull/192)) @quyansiyuanwang
- **updates:** preserve source failures and respect API rate limits ([#195](https://github.com/TunneldeDev/Tunnelde/pull/195)) @quyansiyuanwang
- **terminal:** adapt macOS editing and application clipboard input ([#197](https://github.com/TunneldeDev/Tunnelde/pull/197)) @quyansiyuanwang
- **shortcuts:** retain editor target across shared async actions ([#199](https://github.com/TunneldeDev/Tunnelde/pull/199)) @quyansiyuanwang
- **updates:** retain response context and bound gateway retries ([#201](https://github.com/TunneldeDev/Tunnelde/pull/201), [90c361e](https://github.com/TunneldeDev/Tunnelde/commit/90c361e0ad2d62bf9140c703ff6c3108b0c399f6)) @quyansiyuanwang
- **updates:** give public release manifests their full timeout budget ([#201](https://github.com/TunneldeDev/Tunnelde/pull/201)) @quyansiyuanwang

### 文档 | Docs

- **logging:** describe build source locations without local paths ([#196](https://github.com/TunneldeDev/Tunnelde/pull/196)) @quyansiyuanwang

### 构建 | Build

- **release:** retry transient bundler downloads and uploads ([#198](https://github.com/TunneldeDev/Tunnelde/pull/198)) @quyansiyuanwang

</details>

### 贡献者 | Contributors

@quyansiyuanwang

## [0.32.0](https://github.com/TunneldeDev/Tunnelde/compare/v0.31.0...v0.32.0) - 2026-11-08

### 更新概览 | Highlights

- **plugins:** add runtime-owned status bar contributions
- **files:** batch small files with recoverable memory archives
- **logs:** add dockable filtered output and incremental log reading
- **workbench:** expose runtime-owned tab bar controls to plugins
- **workbench:** add grouped extensible tab bar controls

<details open>
<summary>详细变更 | Details (33)</summary>

### 新增 | New

- **plugins:** add runtime-owned status bar contributions ([#151](https://github.com/TunneldeDev/Tunnelde/pull/151)) @quyansiyuanwang
- **files:** batch small files with recoverable memory archives ([#152](https://github.com/TunneldeDev/Tunnelde/pull/152)) @quyansiyuanwang
- **logs:** add dockable filtered output and incremental log reading ([#158](https://github.com/TunneldeDev/Tunnelde/pull/158), [0f2f13b](https://github.com/TunneldeDev/Tunnelde/commit/0f2f13b99d1f912596cb05bcf8bf4f7c507f7c02)) @quyansiyuanwang
- **workbench:** expose runtime-owned tab bar controls to plugins ([#158](https://github.com/TunneldeDev/Tunnelde/pull/158)) @quyansiyuanwang
- **workbench:** add grouped extensible tab bar controls ([#160](https://github.com/TunneldeDev/Tunnelde/pull/160)) @quyansiyuanwang
- **plugins:** stabilize versioned editor buffer contracts ([#166](https://github.com/TunneldeDev/Tunnelde/pull/166)) @quyansiyuanwang

### 改进 | Improved

- **transfers:** reuse validated source metadata at copy dispatch ([#162](https://github.com/TunneldeDev/Tunnelde/pull/162)) @quyansiyuanwang
- **transfers:** copy same-session files directly on the server ([#173](https://github.com/TunneldeDev/Tunnelde/pull/173)) @quyansiyuanwang

### 修复 | Fix

- **editor:** show format action only for matching plugins ([#143](https://github.com/TunneldeDev/Tunnelde/pull/143)) @quyansiyuanwang
- **transfers:** accelerate source scans and stop on preparation errors ([#145](https://github.com/TunneldeDev/Tunnelde/pull/145)) @quyansiyuanwang
- **workbench:** preview panel resizing without rerendering views ([#146](https://github.com/TunneldeDev/Tunnelde/pull/146)) @quyansiyuanwang
- **forwarding:** wait for listener release before restarting ([#147](https://github.com/TunneldeDev/Tunnelde/pull/147)) @quyansiyuanwang
- **files:** align reordered columns and clarify resize handles ([#149](https://github.com/TunneldeDev/Tunnelde/pull/149)) @quyansiyuanwang
- **network:** distinguish HTTPS failures from proxy tunnel quality ([#150](https://github.com/TunneldeDev/Tunnelde/pull/150)) @quyansiyuanwang
- **files:** include icon spacing in minimum column width ([#153](https://github.com/TunneldeDev/Tunnelde/pull/153)) @quyansiyuanwang
- **transfers:** fence interrupted remote publication ([#154](https://github.com/TunneldeDev/Tunnelde/pull/154)) @quyansiyuanwang
- **plugins:** report first shipped status bar API version ([#155](https://github.com/TunneldeDev/Tunnelde/pull/155)) @quyansiyuanwang
- **files:** fit column widths to content and clarify resize controls ([#156](https://github.com/TunneldeDev/Tunnelde/pull/156)) @quyansiyuanwang
- **transfers:** allow pausing acknowledged writer close waits ([#157](https://github.com/TunneldeDev/Tunnelde/pull/157), [2976e10](https://github.com/TunneldeDev/Tunnelde/commit/2976e10db6a20c362ad15385d5add7972dcc1972)) @quyansiyuanwang
- **transfers:** retain reconnect cleanup requests while busy ([#157](https://github.com/TunneldeDev/Tunnelde/pull/157)) @quyansiyuanwang
- **plugins:** accept compatible host beta versions within engine bounds ([#158](https://github.com/TunneldeDev/Tunnelde/pull/158), [2269e1c](https://github.com/TunneldeDev/Tunnelde/commit/2269e1cf6b23135ce86da31cac573e9a8ac4b817)) @quyansiyuanwang
- **transfers:** fence interrupted remote staging creation ([#159](https://github.com/TunneldeDev/Tunnelde/pull/159)) @quyansiyuanwang
- **transfers:** replay interrupted windows without truncation ([#161](https://github.com/TunneldeDev/Tunnelde/pull/161)) @quyansiyuanwang
- **shortcuts:** expose query filters through a searchable toolbar menu ([#163](https://github.com/TunneldeDev/Tunnelde/pull/163)) @quyansiyuanwang
- **diagnostics:** explain plugin compatibility and update failures ([#164](https://github.com/TunneldeDev/Tunnelde/pull/164)) @quyansiyuanwang
- **output:** use bottom panel and color structured logs ([#165](https://github.com/TunneldeDev/Tunnelde/pull/165)) @quyansiyuanwang
- **files:** explain remote move failures with paths and server status ([#167](https://github.com/TunneldeDev/Tunnelde/pull/167)) @quyansiyuanwang
- **workbench:** route file panel drops consistently and retain dimensions ([#168](https://github.com/TunneldeDev/Tunnelde/pull/168)) @quyansiyuanwang
- **search:** resolve Windows editor roots and preserve remote paths ([#169](https://github.com/TunneldeDev/Tunnelde/pull/169)) @quyansiyuanwang
- **transfers:** verify every retained byte before resuming ([#170](https://github.com/TunneldeDev/Tunnelde/pull/170)) @quyansiyuanwang
- **workbench:** keep closed panels hidden in their remembered layout ([#171](https://github.com/TunneldeDev/Tunnelde/pull/171)) @quyansiyuanwang
- **workbench:** release close listeners before reloading the window ([#172](https://github.com/TunneldeDev/Tunnelde/pull/172)) @quyansiyuanwang

### 文档 | Docs

- provide bilingual readme guides and canonical settings links ([#148](https://github.com/TunneldeDev/Tunnelde/pull/148)) @quyansiyuanwang

</details>

### 贡献者 | Contributors

@quyansiyuanwang

## [0.31.0](https://github.com/TunneldeDev/Tunnelde/compare/v0.30.7...v0.31.0) - 2026-11-07

### 更新概览 | Highlights

- **tasks:** dock background tasks throughout the workbench
- **plugins:** define and verify stable core API contracts
- **files:** preserve selection and focus through file navigation
- **drag:** keep resize handles out of internal drag operations
- **files:** clean up resize gestures and avoid redundant renders

<details open>
<summary>详细变更 | Details (5)</summary>

### 新增 | New

- **tasks:** dock background tasks throughout the workbench ([#138](https://github.com/TunneldeDev/Tunnelde/pull/138)) @quyansiyuanwang
- **plugins:** define and verify stable core API contracts ([#142](https://github.com/TunneldeDev/Tunnelde/pull/142)) @quyansiyuanwang

### 修复 | Fix

- **files:** preserve selection and focus through file navigation ([#140](https://github.com/TunneldeDev/Tunnelde/pull/140), [be0748e](https://github.com/TunneldeDev/Tunnelde/commit/be0748e5f034f5712f49944e5dd1f8cc975f5884)) @quyansiyuanwang
- **drag:** keep resize handles out of internal drag operations ([#140](https://github.com/TunneldeDev/Tunnelde/pull/140)) @quyansiyuanwang
- **files:** clean up resize gestures and avoid redundant renders ([#141](https://github.com/TunneldeDev/Tunnelde/pull/141)) @quyansiyuanwang

</details>

### 贡献者 | Contributors

@quyansiyuanwang

## [0.30.7](https://github.com/TunneldeDev/Tunnelde/compare/v0.30.6...v0.30.7) - 2026-11-07

### 更新概览 | Highlights

- **plugins:** save local text atomically with approval guards
- **plugins:** refresh file panels after local tool saves

<details open>
<summary>详细变更 | Details (2)</summary>

### 修复 | Fix

- **plugins:** save local text atomically with approval guards ([#135](https://github.com/TunneldeDev/Tunnelde/pull/135)) @quyansiyuanwang
- **plugins:** refresh file panels after local tool saves ([#137](https://github.com/TunneldeDev/Tunnelde/pull/137)) @quyansiyuanwang

</details>

### 贡献者 | Contributors

@quyansiyuanwang

## [0.30.6](https://github.com/TunneldeDev/Tunnelde/compare/v0.30.5...v0.30.6) - 2026-11-07

### 更新概览 | Highlights

- **editor:** preserve remote files during failed saves
- **editor:** atomically save local documents and recover staging cleanup
- **tasks:** preserve editor cleanup error details

<details open>
<summary>详细变更 | Details (3)</summary>

### 修复 | Fix

- **editor:** preserve remote files during failed saves ([#131](https://github.com/TunneldeDev/Tunnelde/pull/131)) @quyansiyuanwang
- **editor:** atomically save local documents and recover staging cleanup ([#133](https://github.com/TunneldeDev/Tunnelde/pull/133)) @quyansiyuanwang
- **tasks:** preserve editor cleanup error details ([#134](https://github.com/TunneldeDev/Tunnelde/pull/134)) @quyansiyuanwang

</details>

### 贡献者 | Contributors

@quyansiyuanwang

## [0.30.5](https://github.com/TunneldeDev/Tunnelde/compare/v0.30.4...v0.30.5) - 2026-11-07

### 更新概览 | Highlights

- **files:** recover verified Windows move deletion

<details open>
<summary>详细变更 | Details (1)</summary>

### 修复 | Fix

- **files:** recover verified Windows move deletion ([#129](https://github.com/TunneldeDev/Tunnelde/pull/129)) @quyansiyuanwang

</details>

### 贡献者 | Contributors

@quyansiyuanwang

## [0.30.4](https://github.com/TunneldeDev/Tunnelde/compare/v0.30.3...v0.30.4) - 2026-11-07

### 更新概览 | Highlights

- **helper:** separate native helper release lifecycle

<details open>
<summary>详细变更 | Details (1)</summary>

### 改进 | Improved

- **helper:** separate native helper release lifecycle ([#127](https://github.com/TunneldeDev/Tunnelde/pull/127)) @quyansiyuanwang

</details>

### 贡献者 | Contributors

@quyansiyuanwang

## [0.30.3](https://github.com/TunneldeDev/Tunnelde/compare/v0.30.2...v0.30.3) - 2026-11-07

### 更新概览 | Highlights

- **files:** pipeline directory transfers on shared channels

<details open>
<summary>详细变更 | Details (1)</summary>

### 改进 | Improved

- **files:** pipeline directory transfers on shared channels ([#125](https://github.com/TunneldeDev/Tunnelde/pull/125)) @quyansiyuanwang

</details>

### 贡献者 | Contributors

@quyansiyuanwang

## [0.30.2](https://github.com/TunneldeDev/Tunnelde/compare/v0.30.1...v0.30.2) - 2026-11-07

### 更新概览 | Highlights

- **files:** stop interrupted download source channels promptly
- **files:** commit remote overwrites with atomic rename
- **files:** cancel stalled transfer verification promptly
- **files:** reserve atomic transfer channels
- **files:** publish Windows staging files by handle

<details open>
<summary>详细变更 | Details (5)</summary>

### 修复 | Fix

- **files:** stop interrupted download source channels promptly ([#119](https://github.com/TunneldeDev/Tunnelde/pull/119)) @quyansiyuanwang
- **files:** commit remote overwrites with atomic rename ([#121](https://github.com/TunneldeDev/Tunnelde/pull/121)) @quyansiyuanwang
- **files:** cancel stalled transfer verification promptly ([#122](https://github.com/TunneldeDev/Tunnelde/pull/122)) @quyansiyuanwang
- **files:** reserve atomic transfer channels ([#123](https://github.com/TunneldeDev/Tunnelde/pull/123)) @quyansiyuanwang
- **files:** publish Windows staging files by handle ([#124](https://github.com/TunneldeDev/Tunnelde/pull/124)) @quyansiyuanwang

</details>

### 贡献者 | Contributors

@quyansiyuanwang

## [0.30.1](https://github.com/TunneldeDev/Tunnelde/compare/v0.30.0...v0.30.1) - 2026-11-06

### 更新概览 | Highlights

- **files:** preserve unguarded move sources and backups
- **files:** retain task speed limits across transfer recovery
- **ci:** avoid duplicate checks for release pull requests
- **files:** verify Windows staging identity before resume and cleanup

<details open>
<summary>详细变更 | Details (4)</summary>

### 修复 | Fix

- **files:** preserve unguarded move sources and backups ([#114](https://github.com/TunneldeDev/Tunnelde/pull/114)) @quyansiyuanwang
- **files:** retain task speed limits across transfer recovery ([#116](https://github.com/TunneldeDev/Tunnelde/pull/116)) @quyansiyuanwang
- **ci:** avoid duplicate checks for release pull requests ([#117](https://github.com/TunneldeDev/Tunnelde/pull/117)) @quyansiyuanwang
- **files:** verify Windows staging identity before resume and cleanup ([#118](https://github.com/TunneldeDev/Tunnelde/pull/118)) @quyansiyuanwang

</details>

### 贡献者 | Contributors

@quyansiyuanwang

## [0.30.0](https://github.com/TunneldeDev/Tunnelde/compare/v0.29.0...v0.30.0) - 2026-11-06

### 更新概览 | Highlights

- add independent port forwarding workspace
- resolve plugin shortcut conflicts
- **plugins:** expose API stability metadata
- **files:** Improve file views and same-host moves
- **files:** Support atomic remote move replacement

<details open>
<summary>详细变更 | Details (79)</summary>

### 新增 | New

- add independent port forwarding workspace ([#72](https://github.com/TunneldeDev/Tunnelde/pull/72), [f9caeb6](https://github.com/TunneldeDev/Tunnelde/commit/f9caeb6813cf10844bf85d8280d3698e46f13718)) @quyansiyuanwang
- resolve plugin shortcut conflicts ([#72](https://github.com/TunneldeDev/Tunnelde/pull/72)) @quyansiyuanwang
- **plugins:** expose API stability metadata ([#81](https://github.com/TunneldeDev/Tunnelde/pull/81)) @quyansiyuanwang
- **files:** Improve file views and same-host moves ([#85](https://github.com/TunneldeDev/Tunnelde/pull/85), [6bbb85a](https://github.com/TunneldeDev/Tunnelde/commit/6bbb85a948c86ed88d77198da2dfdbc8468a0793)) @quyansiyuanwang
- **files:** Support atomic remote move replacement ([#85](https://github.com/TunneldeDev/Tunnelde/pull/85), [6237266](https://github.com/TunneldeDev/Tunnelde/commit/6237266dbefac451279c7a2cdfd920a27bba8e05)) @quyansiyuanwang
- **files:** Move file panels when docking ([#85](https://github.com/TunneldeDev/Tunnelde/pull/85), [5946ed9](https://github.com/TunneldeDev/Tunnelde/commit/5946ed919a06cbb48ae6937079e6e289efe5bd96)) @quyansiyuanwang
- **files:** Restore detached local file panels ([#85](https://github.com/TunneldeDev/Tunnelde/pull/85), [e7185ad](https://github.com/TunneldeDev/Tunnelde/commit/e7185ad568795d246337c2bb674e309c04d85d0e)) @quyansiyuanwang
- **files:** Match file connections to current host address ([#85](https://github.com/TunneldeDev/Tunnelde/pull/85), [0f97ab5](https://github.com/TunneldeDev/Tunnelde/commit/0f97ab532813b65143ad9a2391762fd2deb1c1b1)) @quyansiyuanwang
- **files:** Use server-side SFTP copy when available ([#85](https://github.com/TunneldeDev/Tunnelde/pull/85), [7a50739](https://github.com/TunneldeDev/Tunnelde/commit/7a50739fb932711ce48b473b20fa28831bda0a97)) @quyansiyuanwang
- **files:** Restore disconnected remote file panels ([#85](https://github.com/TunneldeDev/Tunnelde/pull/85), [f0d52e4](https://github.com/TunneldeDev/Tunnelde/commit/f0d52e42f728a2dadf1896077c93eb5ea22c16cc)) @quyansiyuanwang
- manage host forwards on dedicated SSH connections ([#97](https://github.com/TunneldeDev/Tunnelde/pull/97), [a72b765](https://github.com/TunneldeDev/Tunnelde/commit/a72b765a060217065164078677382a48d6428b6d)) @quyansiyuanwang

### 改进 | Improved

- **sftp:** avoid duplicate metadata requests during transfer preparation ([#79](https://github.com/TunneldeDev/Tunnelde/pull/79)) @quyansiyuanwang
- simplify forwarding panel ([#84](https://github.com/TunneldeDev/Tunnelde/pull/84)) @quyansiyuanwang
- **macos:** format background lifecycle log ([#87](https://github.com/TunneldeDev/Tunnelde/pull/87), [8f37adc](https://github.com/TunneldeDev/Tunnelde/commit/8f37adca279ca78e1c6c8b71928eb59f55b5e43b)) @quyansiyuanwang

### 修复 | Fix

- **plugins:** expose compatibility and restore query filters ([#72](https://github.com/TunneldeDev/Tunnelde/pull/72), [d360210](https://github.com/TunneldeDev/Tunnelde/commit/d3602108d658462b5e4806b255c41ab37dd0167a)) @quyansiyuanwang
- route plugin shortcuts across scoped handlers ([#74](https://github.com/TunneldeDev/Tunnelde/pull/74)) @quyansiyuanwang
- route plugin shortcuts from terminals ([#76](https://github.com/TunneldeDev/Tunnelde/pull/76)) @quyansiyuanwang
- preserve conflicting plugin action invocations ([#78](https://github.com/TunneldeDev/Tunnelde/pull/78)) @quyansiyuanwang
- **forwarding:** enable panel docking ([#83](https://github.com/TunneldeDev/Tunnelde/pull/83), [93a5d02](https://github.com/TunneldeDev/Tunnelde/commit/93a5d02945021e92ff96577ceabe01a849831cc0)) @quyansiyuanwang
- **forwarding:** route terminal action to dockable panel ([#83](https://github.com/TunneldeDev/Tunnelde/pull/83), [385e21c](https://github.com/TunneldeDev/Tunnelde/commit/385e21c0c53fa83faf32ffb502d4933908608118)) @quyansiyuanwang
- adapt macOS file shortcuts ([#84](https://github.com/TunneldeDev/Tunnelde/pull/84), [ff0b1dd](https://github.com/TunneldeDev/Tunnelde/commit/ff0b1ddd12e6cd3be14aee79ad3e1a88dd56f2d1)) @quyansiyuanwang
- **forwarding:** align empty panel with sidebar design ([#86](https://github.com/TunneldeDev/Tunnelde/pull/86)) @quyansiyuanwang
- **files:** follow active remote source in monitor ([#85](https://github.com/TunneldeDev/Tunnelde/pull/85), [cb97013](https://github.com/TunneldeDev/Tunnelde/commit/cb970134d93e943602e519ed06ece8faa4d819dc)) @quyansiyuanwang
- **macos:** hide Dock icon while running in background ([#87](https://github.com/TunneldeDev/Tunnelde/pull/87), [c18b346](https://github.com/TunneldeDev/Tunnelde/commit/c18b346a39f4de5d36fa2e8874cb2623abec2023)) @quyansiyuanwang
- **dialogs:** focus confirmation actions by default ([#87](https://github.com/TunneldeDev/Tunnelde/pull/87), [ed920cf](https://github.com/TunneldeDev/Tunnelde/commit/ed920cfa1dd57a84cee20f46f1ecc2b27dc44677)) @quyansiyuanwang
- keep focus in topmost dialog ([#87](https://github.com/TunneldeDev/Tunnelde/pull/87)) @quyansiyuanwang
- preserve folders during cross-source moves ([#90](https://github.com/TunneldeDev/Tunnelde/pull/90), [e34d0f9](https://github.com/TunneldeDev/Tunnelde/commit/e34d0f93aa3b7904933dedbd5245b3e73ecab288)) @quyansiyuanwang
- preserve source during local folder merge ([#90](https://github.com/TunneldeDev/Tunnelde/pull/90), [8db90f6](https://github.com/TunneldeDev/Tunnelde/commit/8db90f6c769fc86a58a3c516606db43d777b84ca)) @quyansiyuanwang
- reject unsafe folder moves before traversal ([#90](https://github.com/TunneldeDev/Tunnelde/pull/90)) @quyansiyuanwang
- show actionable plugin startup diagnostics ([#96](https://github.com/TunneldeDev/Tunnelde/pull/96)) @quyansiyuanwang
- keep forwarding connection controls available ([#97](https://github.com/TunneldeDev/Tunnelde/pull/97)) @quyansiyuanwang
- preserve transfer backups when destination exists ([#92](https://github.com/TunneldeDev/Tunnelde/pull/92), [2a20905](https://github.com/TunneldeDev/Tunnelde/commit/2a20905c715ad793e2715de1741a54fbdbad19d7)) @quyansiyuanwang
- preserve backups during uncertain recovery ([#92](https://github.com/TunneldeDev/Tunnelde/pull/92), [d57aff5](https://github.com/TunneldeDev/Tunnelde/commit/d57aff5e5503db28118c76d8b9254a59ff5de74a)) @quyansiyuanwang
- show transfer backup recovery paths ([#92](https://github.com/TunneldeDev/Tunnelde/pull/92), [2587710](https://github.com/TunneldeDev/Tunnelde/commit/258771028dad25b6bf3567037d218537da6d6435)) @quyansiyuanwang
- retain recovery paths across cleanup retries ([#92](https://github.com/TunneldeDev/Tunnelde/pull/92), [18d642c](https://github.com/TunneldeDev/Tunnelde/commit/18d642ccf2f8ead7ff56df0617747f8da632fcac)) @quyansiyuanwang
- report unrecognized transfer backup paths ([#92](https://github.com/TunneldeDev/Tunnelde/pull/92), [d55f342](https://github.com/TunneldeDev/Tunnelde/commit/d55f342f4cad4f5140f26fae1ab4dc248c32875a)) @quyansiyuanwang
- retain backup recovery details after cancellation ([#92](https://github.com/TunneldeDev/Tunnelde/pull/92)) @quyansiyuanwang
- **transfers:** commit local files without replacing concurrent targets ([#98](https://github.com/TunneldeDev/Tunnelde/pull/98)) @quyansiyuanwang
- **transfers:** avoid recursive deletion of transfer artifacts ([#99](https://github.com/TunneldeDev/Tunnelde/pull/99), [e6035f1](https://github.com/TunneldeDev/Tunnelde/commit/e6035f1a735203d2163712418fc3bc9a9bef961b)) @quyansiyuanwang
- **transfers:** explain cleanup failures without assuming a disconnect ([#99](https://github.com/TunneldeDev/Tunnelde/pull/99)) @quyansiyuanwang
- **windows:** delete verified transfer backups through held handles ([#101](https://github.com/TunneldeDev/Tunnelde/pull/101)) @quyansiyuanwang
- **plugins:** connect saved hosts from assistant execution selector ([#103](https://github.com/TunneldeDev/Tunnelde/pull/103)) @quyansiyuanwang
- **files:** preserve concurrently created rename destinations ([#104](https://github.com/TunneldeDev/Tunnelde/pull/104)) @quyansiyuanwang
- **release:** retry transient changelog history reads ([#105](https://github.com/TunneldeDev/Tunnelde/pull/105)) @quyansiyuanwang
- **plugins:** initialize the selected agent permission mode ([#106](https://github.com/TunneldeDev/Tunnelde/pull/106)) @quyansiyuanwang
- **files:** preserve interrupted move sources on retry ([#107](https://github.com/TunneldeDev/Tunnelde/pull/107)) @quyansiyuanwang
- **files:** expose manual move recovery paths ([#109](https://github.com/TunneldeDev/Tunnelde/pull/109)) @quyansiyuanwang
- **files:** guard local Windows move verification and deletion ([#110](https://github.com/TunneldeDev/Tunnelde/pull/110)) @quyansiyuanwang
- **files:** route cross-drive operations through background transfers ([#89](https://github.com/TunneldeDev/Tunnelde/pull/89)) @quyansiyuanwang
- **files:** refresh all views after background transfers ([#111](https://github.com/TunneldeDev/Tunnelde/pull/111)) @quyansiyuanwang
- **files:** compare completed transfers before move source deletion ([#112](https://github.com/TunneldeDev/Tunnelde/pull/112)) @quyansiyuanwang

### 文档 | Docs

- correct shortcut and network guidance ([#75](https://github.com/TunneldeDev/Tunnelde/pull/75), [4d4f8ec](https://github.com/TunneldeDev/Tunnelde/commit/4d4f8ec812fdd7a8b0050781b948eb0ff6feaaeb)) @quyansiyuanwang
- remove stale marketplace availability claims ([#75](https://github.com/TunneldeDev/Tunnelde/pull/75), [9972f82](https://github.com/TunneldeDev/Tunnelde/commit/9972f823a53123081ec7fc7fbf5e58080340de90)) @quyansiyuanwang
- add bilingual shortcut guide ([#75](https://github.com/TunneldeDev/Tunnelde/pull/75), [3dde918](https://github.com/TunneldeDev/Tunnelde/commit/3dde918e9193bd003a983ce2f106e5cb075cc01e)) @quyansiyuanwang
- update feature and assistant availability ([#75](https://github.com/TunneldeDev/Tunnelde/pull/75), [db7bbfa](https://github.com/TunneldeDev/Tunnelde/commit/db7bbfacb3df7af250edc9b26c2a54dfdc2ca406)) @quyansiyuanwang
- translate network and transfer guide ([#75](https://github.com/TunneldeDev/Tunnelde/pull/75), [fcbf4c1](https://github.com/TunneldeDev/Tunnelde/commit/fcbf4c18a0dfaf4abed8f04e582b5037a4479288)) @quyansiyuanwang
- preserve network guide section links ([#75](https://github.com/TunneldeDev/Tunnelde/pull/75), [a7aaa40](https://github.com/TunneldeDev/Tunnelde/commit/a7aaa40510eba067257848a18a8d704e24a659e6)) @quyansiyuanwang
- translate assistant setup guide ([#75](https://github.com/TunneldeDev/Tunnelde/pull/75), [7b30df1](https://github.com/TunneldeDev/Tunnelde/commit/7b30df1eaa17ca5606e6070a52af7fbae4476e5a)) @quyansiyuanwang
- translate troubleshooting guide ([#75](https://github.com/TunneldeDev/Tunnelde/pull/75), [79966c6](https://github.com/TunneldeDev/Tunnelde/commit/79966c6cdfd6d5d948c662ec59ea2608e754a188)) @quyansiyuanwang
- clarify plugin shortcuts in terminals ([#75](https://github.com/TunneldeDev/Tunnelde/pull/75)) @quyansiyuanwang
- provide bilingual settings guide ([#77](https://github.com/TunneldeDev/Tunnelde/pull/77)) @quyansiyuanwang
- present plugin ecosystem without fixed catalogue ([#88](https://github.com/TunneldeDev/Tunnelde/pull/88), [cee5c8c](https://github.com/TunneldeDev/Tunnelde/commit/cee5c8c262aaa92c393fb29502e2d4b1ec707465)) @quyansiyuanwang
- clarify file drag and drop behavior ([#88](https://github.com/TunneldeDev/Tunnelde/pull/88)) @quyansiyuanwang
- provide bilingual architecture and release guides ([#93](https://github.com/TunneldeDev/Tunnelde/pull/93)) @quyansiyuanwang
- explain plugin API compatibility and security ([#94](https://github.com/TunneldeDev/Tunnelde/pull/94)) @quyansiyuanwang
- complete bilingual plugin development guides ([#100](https://github.com/TunneldeDev/Tunnelde/pull/100)) @quyansiyuanwang

### 构建 | Build

- avoid duplicate macOS Rust compilation ([#80](https://github.com/TunneldeDev/Tunnelde/pull/80)) @quyansiyuanwang
- **plugins:** validate stable discovery contract ([#82](https://github.com/TunneldeDev/Tunnelde/pull/82)) @quyansiyuanwang
- **forwarding:** update terminal panel expectations ([#83](https://github.com/TunneldeDev/Tunnelde/pull/83)) @quyansiyuanwang
- **files:** simplify SFTP test request type ([#85](https://github.com/TunneldeDev/Tunnelde/pull/85), [c90a847](https://github.com/TunneldeDev/Tunnelde/commit/c90a847de410344521bb3b2c09c3162ae979bb24)) @quyansiyuanwang
- **helper:** accept closed pipe on unexpected exit ([#85](https://github.com/TunneldeDev/Tunnelde/pull/85)) @quyansiyuanwang
- cover remote directory move protection ([#90](https://github.com/TunneldeDev/Tunnelde/pull/90), [92ee28a](https://github.com/TunneldeDev/Tunnelde/commit/92ee28aeb0be749794242300aacc6476fb9ed1f4)) @quyansiyuanwang
- show localized directory move failure ([#90](https://github.com/TunneldeDev/Tunnelde/pull/90), [995c5f5](https://github.com/TunneldeDev/Tunnelde/commit/995c5f593a288385a7b1056a6ec84898d6d90380)) @quyansiyuanwang
- preserve ordinary directory rename behavior ([#90](https://github.com/TunneldeDev/Tunnelde/pull/90), [4225006](https://github.com/TunneldeDev/Tunnelde/commit/4225006e023804682038b4630e4a26c01fbf2689)) @quyansiyuanwang
- compare SDK parser with host discovery ([#95](https://github.com/TunneldeDev/Tunnelde/pull/95)) @quyansiyuanwang
- document backup cleanup replacement race ([#92](https://github.com/TunneldeDev/Tunnelde/pull/92), [ffaacd6](https://github.com/TunneldeDev/Tunnelde/commit/ffaacd6669e88053b5b44e352be4f32927345db0)) @quyansiyuanwang
- retain macOS application dependency cache on integration branches ([#102](https://github.com/TunneldeDev/Tunnelde/pull/102), [b10c3e8](https://github.com/TunneldeDev/Tunnelde/commit/b10c3e8e0db1c8c8b2e847a8fbac1eec5e057d87)) @quyansiyuanwang
- bound Linux dependency downloads and avoid interactive upgrades ([#102](https://github.com/TunneldeDev/Tunnelde/pull/102)) @quyansiyuanwang
- stabilize Linux build dependency downloads ([#108](https://github.com/TunneldeDev/Tunnelde/pull/108)) @quyansiyuanwang

</details>

### 贡献者 | Contributors

@quyansiyuanwang

## [0.29.0](https://github.com/TunneldeDev/Tunnelde/compare/v0.28.0...v0.29.0) - 2026-11-05

### 更新概览 | Highlights

- 存储位置支持逐项或批量恢复默认，并在迁移前展示计划、保护已有数据。Storage locations can reset individually or in batches with a reviewed migration plan and existing-data protection.
- 插件可直接格式化当前编辑器文件，支持可配置快捷键、撤销重做和异步修改冲突保护。Plugins can format the active editor with configurable shortcuts, undo/redo and protection against stale asynchronous edits.
- 更新说明可展开查看当前版本至目标版本的累计变更；历史不完整或加载失败时会明确提示并允许重试。Update notes include changes from the installed version through the selected target, with clear incomplete-history notices and retry.
- 测试连接显示沿实际代理与跳板路径的三次 SSH 建立耗时、波动和成功次数，支持取消与重测。Connection tests show three SSH establishment measurements through the configured route, their spread and success count, with cancel and retry.

<details open>
<summary>详细变更 | Details (26)</summary>

### 新增 | New

- **storage:** add individual and batch location reset ([#52](https://github.com/TunneldeDev/Tunnelde/pull/52)) @quyansiyuanwang
- **plugins:** expose versioned editor buffers with undoable edits ([#54](https://github.com/TunneldeDev/Tunnelde/pull/54), [f7027f3](https://github.com/TunneldeDev/Tunnelde/commit/f7027f317e20e14dedecadb48cb81cde01fcac4b)) @quyansiyuanwang
- **editor:** run contributed formatters and configurable shortcuts ([#54](https://github.com/TunneldeDev/Tunnelde/pull/54)) @quyansiyuanwang
- **updates:** fetch bounded cumulative release history ([#55](https://github.com/TunneldeDev/Tunnelde/pull/55), [8462666](https://github.com/TunneldeDev/Tunnelde/commit/8462666f9fa9b092321270d0facb8013e014bea2)) @quyansiyuanwang
- **updates:** review changes across versions in settings ([#55](https://github.com/TunneldeDev/Tunnelde/pull/55)) @quyansiyuanwang
- **ssh:** measure cancellable connection quality through host routes ([#56](https://github.com/TunneldeDev/Tunnelde/pull/56), [ca77d4c](https://github.com/TunneldeDev/Tunnelde/commit/ca77d4ceb77dfe98c58fcdcd5b99261f91942ecd)) @quyansiyuanwang
- **connect:** show route quality and isolate connection dialog state ([#56](https://github.com/TunneldeDev/Tunnelde/pull/56)) @quyansiyuanwang
- add restart and reload controls ([#61](https://github.com/TunneldeDev/Tunnelde/pull/61)) @quyansiyuanwang
- add application and operation log viewer ([#62](https://github.com/TunneldeDev/Tunnelde/pull/62)) @quyansiyuanwang
- **files:** add native file manager actions ([#63](https://github.com/TunneldeDev/Tunnelde/pull/63)) @quyansiyuanwang
- **files:** open local and remote documents consistently ([#64](https://github.com/TunneldeDev/Tunnelde/pull/64)) @quyansiyuanwang
- **plugins:** contribute file actions and mounted file reveal ([#65](https://github.com/TunneldeDev/Tunnelde/pull/65), [45757b4](https://github.com/TunneldeDev/Tunnelde/commit/45757b4e650997ba3c0ff2970cd364c07930db2d)) @quyansiyuanwang

### 改进 | Improved

- **plugins:** isolate session API representation ([#68](https://github.com/TunneldeDev/Tunnelde/pull/68)) @quyansiyuanwang

### 修复 | Fix

- **storage:** safely migrate categories back to default locations ([#52](https://github.com/TunneldeDev/Tunnelde/pull/52), [d698e3d](https://github.com/TunneldeDev/Tunnelde/commit/d698e3db45e6a339d944645e8571705688774490)) @quyansiyuanwang
- **release:** keep highlights within the current promotion cycle ([#57](https://github.com/TunneldeDev/Tunnelde/pull/57)) @quyansiyuanwang
- **network:** show latency and quality after connection tests ([#58](https://github.com/TunneldeDev/Tunnelde/pull/58)) @quyansiyuanwang
- **release:** stop Nightly publishing and version macOS update archives ([#59](https://github.com/TunneldeDev/Tunnelde/pull/59)) @quyansiyuanwang
- **plugins:** overlay scrollbars without narrowing extension rows ([#60](https://github.com/TunneldeDev/Tunnelde/pull/60)) @quyansiyuanwang
- **sshfs:** cancel delayed mounted file opening ([#65](https://github.com/TunneldeDev/Tunnelde/pull/65), [6796f88](https://github.com/TunneldeDev/Tunnelde/commit/6796f88b10de4768cd43aeb1ad58625f550a8892)) @quyansiyuanwang
- **sshfs:** check mounted filesystem on macos ([#65](https://github.com/TunneldeDev/Tunnelde/pull/65)) @quyansiyuanwang
- **plugins:** preserve split utf8 after invalid bytes ([#70](https://github.com/TunneldeDev/Tunnelde/pull/70)) @quyansiyuanwang
- **plugins:** release cancelled pending requests ([#71](https://github.com/TunneldeDev/Tunnelde/pull/71)) @quyansiyuanwang

### 文档 | Docs

- **plugins:** clarify ecosystem and compatibility ([#66](https://github.com/TunneldeDev/Tunnelde/pull/66)) @quyansiyuanwang

### 构建 | Build

- **sshfs:** exercise passive mount with local sftp ([#65](https://github.com/TunneldeDev/Tunnelde/pull/65), [2c372f6](https://github.com/TunneldeDev/Tunnelde/commit/2c372f6282fe7bfdb6c0ea8a49e9667226db909d)) @quyansiyuanwang
- **plugins:** exercise historical plugin transport ([#67](https://github.com/TunneldeDev/Tunnelde/pull/67)) @quyansiyuanwang
- **plugins:** exercise persisted storage contracts ([#69](https://github.com/TunneldeDev/Tunnelde/pull/69)) @quyansiyuanwang

</details>

### 贡献者 | Contributors

@quyansiyuanwang

## [0.28.0](https://github.com/TunneldeDev/Tunnelde/compare/v0.27.1...v0.28.0) - 2026-11-05

### 更新概览 | Highlights

- 文件浏览支持按层级展开的分栏视图、可复用的预览标签，以及插件提供的文件图标与内容预览。File browsing adds hierarchical columns, reusable preview tabs, and plugin-provided icons and previews.
- 传输增加并发、断点续传、限速和适用时的压缩；公共后台任务面板提供进度反馈、拖动缩放及批量清理。Transfers add concurrency, resume checkpoints, bandwidth limits and adaptive compression; shared background tasks provide progress, movable/resizable UI and bulk cleanup.
- 远端进程管理支持自动刷新、区间 CPU 统计、用户与用户组，以及系统权限允许时的磁盘、网络和 GPU 数据。Remote process management adds automatic refresh, interval CPU measurements, ownership details, and disk, network and GPU metrics where available.
- 存储分类支持位置设置与重启迁移；托盘驻留可释放 WebView，并恢复工作区和终端状态。Storage categories support custom locations and restart migration; tray suspension can release the WebView and restore workspace and terminal state.
- 公测编号统一为 beta.1～beta.9，达到上限后必须先审查并发布正式版；更新检查保留历史版本兼容。Beta milestones are limited to beta.1–beta.9 before reviewed stable promotion, while update discovery retains historical compatibility.
- 软件更新只提供正式版和公测版；历史开发版渠道设置迁移为正式版，防止误更新到开发快照。In-app updates offer only Stable and Public beta; legacy development-channel preferences migrate to Stable.

<details open>
<summary>详细变更 | Details (43)</summary>

### 新增 | New

- **files:** add column browsing and reliable transfer cleanup ([#26](https://github.com/TunneldeDev/Tunnelde/pull/26)) @quyansiyuanwang
- **files:** add direct local and remote file previews ([#28](https://github.com/TunneldeDev/Tunnelde/pull/28), [29819aa](https://github.com/TunneldeDev/Tunnelde/commit/29819aae2a8479fd4debdfab478ada885025593f)) @quyansiyuanwang
- **hosts:** move tag filters into search suggestions ([#28](https://github.com/TunneldeDev/Tunnelde/pull/28), [41ca75d](https://github.com/TunneldeDev/Tunnelde/commit/41ca75db3a07766871b12890d1492e883b461429)) @quyansiyuanwang
- **workspace:** reuse preview tabs until kept open ([#28](https://github.com/TunneldeDev/Tunnelde/pull/28), [856a314](https://github.com/TunneldeDev/Tunnelde/commit/856a314da280a9f40fe3debe98cb9faefe4eec24)) @quyansiyuanwang
- **ssh:** expose forwarding with clear endpoint directions ([#28](https://github.com/TunneldeDev/Tunnelde/pull/28), [6148d69](https://github.com/TunneldeDev/Tunnelde/commit/6148d696e8b3bc35282fd871c04f2462812b7eaa)) @quyansiyuanwang
- **forwarding:** simplify setup and rule management ([#29](https://github.com/TunneldeDev/Tunnelde/pull/29)) @quyansiyuanwang
- **transfers:** add bounded parallel SFTP transfers and resume checkpoints ([#31](https://github.com/TunneldeDev/Tunnelde/pull/31), [f899fa1](https://github.com/TunneldeDev/Tunnelde/commit/f899fa1ca83828317cce4e6c9155085c3c7d72aa)) @quyansiyuanwang
- **transfers:** add live shared bandwidth and per-task limits ([#31](https://github.com/TunneldeDev/Tunnelde/pull/31), [ec05c4f](https://github.com/TunneldeDev/Tunnelde/commit/ec05c4f6e5ae1b4c2fab4134f2bd6a3d5bafcc95)) @quyansiyuanwang
- **plugins:** add paged discovery and searchable tags ([#32](https://github.com/TunneldeDev/Tunnelde/pull/32)) @quyansiyuanwang
- **events:** add typed shared subscriptions with abortable lifetimes ([#33](https://github.com/TunneldeDev/Tunnelde/pull/33), [f70562a](https://github.com/TunneldeDev/Tunnelde/commit/f70562afbf87f76269972419a3cae787d41fee19)) @quyansiyuanwang
- **plugins:** support declarative file icon themes ([#34](https://github.com/TunneldeDev/Tunnelde/pull/34)) @quyansiyuanwang
- **files:** add plugin previews with bounded local and SSH reads ([#35](https://github.com/TunneldeDev/Tunnelde/pull/35)) @quyansiyuanwang
- **storage:** add per-category locations and verified restart migrations ([#36](https://github.com/TunneldeDev/Tunnelde/pull/36)) @quyansiyuanwang
- **terminal:** checkpoint terminal state and buffer detached SSH output ([#37](https://github.com/TunneldeDev/Tunnelde/pull/37), [977f16e](https://github.com/TunneldeDev/Tunnelde/commit/977f16ed64e749d5ca7a7dbdc382ab2c5adb0e34)) @quyansiyuanwang
- **workspace:** release tray WebView and restore live workspaces ([#37](https://github.com/TunneldeDev/Tunnelde/pull/37)) @quyansiyuanwang
- **transfers:** show compact background tasks from every page ([#39](https://github.com/TunneldeDev/Tunnelde/pull/39), [f6b8c78](https://github.com/TunneldeDev/Tunnelde/commit/f6b8c78e5e108414a140ed1369af33a7aa3c77b8)) @quyansiyuanwang
- **transfers:** queue tasks within shared SSH channel budgets ([#41](https://github.com/TunneldeDev/Tunnelde/pull/41), [405fa23](https://github.com/TunneldeDev/Tunnelde/commit/405fa235e39b00e67e20809ba55076d8e31e4383)) @quyansiyuanwang
- **transfers:** move and resize the background task window ([#41](https://github.com/TunneldeDev/Tunnelde/pull/41)) @quyansiyuanwang
- **transfers:** compress beneficial data over ephemeral SSH workers ([#43](https://github.com/TunneldeDev/Tunnelde/pull/43)) @quyansiyuanwang
- **tasks:** share background work across application features ([#46](https://github.com/TunneldeDev/Tunnelde/pull/46), [c3e4ad8](https://github.com/TunneldeDev/Tunnelde/commit/c3e4ad8effd55e653bae955a2f27b0decc548eee)) @quyansiyuanwang
- **tasks:** show live progress and bulk clear finished records ([#46](https://github.com/TunneldeDev/Tunnelde/pull/46)) @quyansiyuanwang
- **monitor:** sample interval CPU and per-process resource counters ([#48](https://github.com/TunneldeDev/Tunnelde/pull/48), [ffa536d](https://github.com/TunneldeDev/Tunnelde/commit/ffa536d9ff19f4fc87d275377604803a6512f5f4)) @quyansiyuanwang
- **monitor:** add live process management and resource details ([#48](https://github.com/TunneldeDev/Tunnelde/pull/48)) @quyansiyuanwang

### 改进 | Improved

- **transfers:** fill SFTP pipelines with negotiated packet sizes ([#40](https://github.com/TunneldeDev/Tunnelde/pull/40)) @quyansiyuanwang
- isolate monitor curves and batch sidebar resizing ([#45](https://github.com/TunneldeDev/Tunnelde/pull/45)) @quyansiyuanwang

### 修复 | Fix

- **updates:** recover channel discovery when GitHub API is unavailable ([#28](https://github.com/TunneldeDev/Tunnelde/pull/28), [d577be6](https://github.com/TunneldeDev/Tunnelde/commit/d577be615882b7a01519557931d617e53923a03c)) @quyansiyuanwang
- **workspace:** preserve plugin API pages and modified preview tabs ([#28](https://github.com/TunneldeDev/Tunnelde/pull/28), [0fdd79d](https://github.com/TunneldeDev/Tunnelde/commit/0fdd79dc424743b08c470787d20927d9e723ada9)) @quyansiyuanwang
- **tabs:** preserve page icons when keeping tabs open ([#29](https://github.com/TunneldeDev/Tunnelde/pull/29), [414a17f](https://github.com/TunneldeDev/Tunnelde/commit/414a17fee41d91a254492a5a45d6d6a761b1ece3)) @quyansiyuanwang
- **updates:** default all builds to stable channel ([#30](https://github.com/TunneldeDev/Tunnelde/pull/30)) @quyansiyuanwang
- **quick-access:** focus the complete search field ([#31](https://github.com/TunneldeDev/Tunnelde/pull/31), [bfb8068](https://github.com/TunneldeDev/Tunnelde/commit/bfb8068016d82f332bd46a0c58fb79b1519d72fb)) @quyansiyuanwang
- **transfers:** clean cancelled staging and retain pause checkpoints ([#31](https://github.com/TunneldeDev/Tunnelde/pull/31)) @quyansiyuanwang
- **events:** reconcile missed changes and release view subscriptions ([#33](https://github.com/TunneldeDev/Tunnelde/pull/33)) @quyansiyuanwang
- **preview:** restore playable sources after media lifecycle cleanup ([#38](https://github.com/TunneldeDev/Tunnelde/pull/38)) @quyansiyuanwang
- **transfers:** recover across SSH reconnects and defer offline cleanup ([#39](https://github.com/TunneldeDev/Tunnelde/pull/39), [eeefc7f](https://github.com/TunneldeDev/Tunnelde/commit/eeefc7fd22b4f4eed213bfe17a1b058f24ee6f4b)) @quyansiyuanwang
- **transfers:** reconcile startup tasks and preserve tray panel state ([#39](https://github.com/TunneldeDev/Tunnelde/pull/39)) @quyansiyuanwang
- **transfers:** keep SFTP requests moving while throttled ([#41](https://github.com/TunneldeDev/Tunnelde/pull/41), [7dec9ca](https://github.com/TunneldeDev/Tunnelde/commit/7dec9cab5ffe1afb9e43c5b4e5a91b1f51d109ee)) @quyansiyuanwang
- **releases:** use two-digit semver-compatible beta identifiers ([#47](https://github.com/TunneldeDev/Tunnelde/pull/47), [046710f](https://github.com/TunneldeDev/Tunnelde/commit/046710f88b2c0a44cfeb307efea1a1902cd89dde)) @quyansiyuanwang
- **releases:** simplify beta names and bridge older updaters ([#47](https://github.com/TunneldeDev/Tunnelde/pull/47)) @quyansiyuanwang
- **releases:** cap beta milestones before stable promotion ([#49](https://github.com/TunneldeDev/Tunnelde/pull/49)) @quyansiyuanwang
- **updates:** restrict public update channels to stable and beta ([#50](https://github.com/TunneldeDev/Tunnelde/pull/50)) @quyansiyuanwang

### 文档 | Docs

- explain previews host filters and SSH forwarding ([#28](https://github.com/TunneldeDev/Tunnelde/pull/28)) @quyansiyuanwang
- align feature guides with implementation and marketplace ([#42](https://github.com/TunneldeDev/Tunnelde/pull/42)) @quyansiyuanwang

### 其他 | Other

- remove unused brand copies and legacy plugin directory ([#44](https://github.com/TunneldeDev/Tunnelde/pull/44)) @quyansiyuanwang

</details>

### 贡献者 | Contributors

@quyansiyuanwang

## [0.27.1](https://github.com/TunneldeDev/Tunnelde/compare/v0.27.0...v0.27.1) - 2026-11-03

### 更新概览 | Highlights

- **ci:** recover stalled Rust cache restores
- **startup:** restore saved appearance before showing the window
- **settings:** align network and proxy configuration layouts
- **release:** correct channels and update restart recovery

<details open>
<summary>详细变更 | Details (4)</summary>

### 修复 | Fix

- **ci:** recover stalled Rust cache restores ([#20](https://github.com/TunneldeDev/Tunnelde/pull/20)) @quyansiyuanwang
- **startup:** restore saved appearance before showing the window ([#21](https://github.com/TunneldeDev/Tunnelde/pull/21)) @quyansiyuanwang
- **settings:** align network and proxy configuration layouts ([#22](https://github.com/TunneldeDev/Tunnelde/pull/22)) @quyansiyuanwang
- **release:** correct channels and update restart recovery ([#25](https://github.com/TunneldeDev/Tunnelde/pull/25)) @quyansiyuanwang

</details>

### 贡献者 | Contributors

@quyansiyuanwang

## [0.27.0](https://github.com/TunneldeDev/Tunnelde/compare/v0.26.1...v0.27.0) - 2026-11-03

### 更新概览 | Highlights

- **network:** add proxies, jump hosts, resumable transfers, SSHFS and forwarding
- **updates:** integrate update channels and sources into settings
- **release:** support rebase merges with commit validation
- **sshfs:** compile the process launcher on Unix
- **release:** reset beta sequences for each target version

<details open>
<summary>详细变更 | Details (8)</summary>

### 新增 | New

- **network:** add proxies, jump hosts, resumable transfers, SSHFS and forwarding ([#17](https://github.com/TunneldeDev/Tunnelde/pull/17), [16ff59d](https://github.com/TunneldeDev/Tunnelde/commit/16ff59d6a32e96a77c96b50eb3cd59f424da5021)) @quyansiyuanwang
- **updates:** integrate update channels and sources into settings ([#17](https://github.com/TunneldeDev/Tunnelde/pull/17), [1ae8993](https://github.com/TunneldeDev/Tunnelde/commit/1ae8993f4e356276945b66d1506be0049890caed)) @quyansiyuanwang
- **release:** support rebase merges with commit validation ([#17](https://github.com/TunneldeDev/Tunnelde/pull/17)) @quyansiyuanwang

### 修复 | Fix

- **sshfs:** compile the process launcher on Unix ([#17](https://github.com/TunneldeDev/Tunnelde/pull/17), [062d92f](https://github.com/TunneldeDev/Tunnelde/commit/062d92fe499b44ce1cfbc4fbf4b3542eb273d079)) @quyansiyuanwang
- **release:** reset beta sequences for each target version ([#17](https://github.com/TunneldeDev/Tunnelde/pull/17), [42843e8](https://github.com/TunneldeDev/Tunnelde/commit/42843e81158a3de96a98a650bbdc02bd9735f6b1)) @quyansiyuanwang
- **ci:** recover delayed release PR checks and transient API errors ([#18](https://github.com/TunneldeDev/Tunnelde/pull/18)) @quyansiyuanwang
- **release:** preserve dev commits in stable promotions ([#19](https://github.com/TunneldeDev/Tunnelde/pull/19)) @quyansiyuanwang

### 构建 | Build

- add dev Nightly and automatic stable releases ([#15](https://github.com/TunneldeDev/Tunnelde/pull/15), [cbcf288](https://github.com/TunneldeDev/Tunnelde/commit/cbcf2889423899a2c46644e750460cfa56103fef)) @quyansiyuanwang

</details>

### 贡献者 | Contributors

@quyansiyuanwang

## [0.26.1](https://github.com/TunneldeDev/Tunnelde/compare/v0.26.0...v0.26.1) - 2026-11-03

### 更新概览 | Highlights

**Build**

- Protect main with required PR/CI checks and maintain a cumulative release PR with synchronized versions and generated notes. Build installers only after merging the release PR, and retain validated releases as drafts for manual publication.
- Build both macOS architectures on Intel runners, with arm64 cross compilation and executable/signature validation, avoiding Apple Silicon runner capacity failures. Allow interrupted draft releases to resume using updated build infrastructure without changing their tagged source.
- Stop generating unused C static/shared libraries for the desktop app while retaining full LTO and size optimization. Share release dependency caches with reproducible build measurements and keep compiler timing reports as Actions artifacts.

<details open>
<summary>详细变更 | Details (7)</summary>

### 构建 | Build

- cross-compile macOS arm64 releases on Intel runners ([00dc256](https://github.com/TunneldeDev/Tunnelde/commit/00dc25623b4b3e9f4e1242f5cbf54d6fd425f31a)) @quyansiyuanwang
- remove unused library outputs and measure release builds ([6cf7182](https://github.com/TunneldeDev/Tunnelde/commit/6cf7182ef576ac32fa46fbb11328358c51ce7fd9)) @quyansiyuanwang
- protect main and prepare reviewed draft releases ([#11](https://github.com/TunneldeDev/Tunnelde/pull/11)) @quyansiyuanwang
- **release:** summarize changelogs and add citation metadata ([#14](https://github.com/TunneldeDev/Tunnelde/pull/14)) @quyansiyuanwang
- **deps:** bump i18next from 26.5.11 to 26.5.12 ([#9](https://github.com/TunneldeDev/Tunnelde/pull/9))
- **deps:** bump lucide-react from 1.64.0 to 1.65.0 ([#10](https://github.com/TunneldeDev/Tunnelde/pull/10)) @quyansiyuanwang
- **deps:** bump googleapis/release-please-action from 8b8fd2cc23b2e18957157a9d923d75aa0c6f6ad5 to 5c625bfb5d1ff62eadeeb3772007f7f66fdcf071 ([#12](https://github.com/TunneldeDev/Tunnelde/pull/12))

</details>

### 贡献者 | Contributors

@quyansiyuanwang

## [0.26.0] - 2026-11-02

### Added

- Save, replace or remove a host password directly in the host editor using the operating system credential store. Blank fields preserve existing credentials; failed vault saves retain the draft for retry without creating duplicate hosts.
- Connect directly on host double click or Enter by default, with a Workspace preference to show the connection dialog every time. Missing credentials and untrusted or changed server keys still open the connection dialog.
- Require assistant initialization on the selected machine before showing Send. Remote runtime installation and agent preparation have explicit consent, protocol checks, available account/model-state checks and cancellation. Requires assistant packages 1.4.0.

### Fixed

- Bind host-key trust approval to the fingerprint actually displayed. A key that changes during approval is rejected and refreshed for review; approved keys with available credentials continue straight to connection.
- Render right-click and ellipsis menus with the same menu items, icons, spacing and keyboard behavior while retaining their respective pointer/button anchors.
- Select connected SSH hosts directly from the assistant location menu. Preparation errors no longer consume user messages or falsely mark a missing remote runtime as ready.

## [0.25.1] - 2026-11-02

### Fixed

- Use the full chat pane with centered message and composer columns, including editor and sidebar docking. Keep long execution-target names from pushing the send button outside narrow panes.
- Give multi-line menu entries their natural height, preventing overlapping host addresses and approval descriptions.
- Keep SSH connection names synchronized after renaming a host. Show one assistant target per saved host and connected address, preserving the selected connection instead of switching terminals.
- Replace the assistant session dropdown with searchable history and direct per-row rename/delete actions. Deleting another conversation preserves the active conversation, draft, model and approval choice; running conversations remain protected.
- Localize untitled conversations without changing custom names, and update background conversation completion in history. Requires assistant packages 1.3.1 for the new session metadata and rename action.
- Keep provider configuration in the chat toolbar and workspace options in the target menu.

## [0.25.0] - 2026-11-02

### Added

- A separate execution-location selector for assistant plugins: choose this computer or a connected SSH host directly, with automatic home-directory resolution and optional workspace/executable overrides. Requires assistant packages 1.3.0 from Tunnelde Hub.
- A native permission-checked SFTP directory resolver for plugins, accepting home-relative and relative directories without running a shell or enumerating home contents.
- Universal Quick Access with F1 / Ctrl/Cmd+Shift+P, `>` application and plugin commands, `%` directory content search, `@` hosts, and Ctrl/Cmd+P for files/open tabs. Installed plugin commands and views can be assigned shortcuts and included in settings profiles.
- Cancellable, bounded native local/SFTP search with an explicit directory selector, read-only local previews, and remote editor line navigation that preserves unsaved text.
- Host API methods to open Quick Access, set pane destination locks and resize existing splits, with normal workspace permissions and parameter validation.
- Per-turn collapsible AI activity shared by all four assistant plugins, including structured thinking, tool execution and output from the actual Codex, Claude Code and Pi protocols.

### Fixed

- Preserve composer drafts when changing execution targets creates a new conversation. Keep model selection separate from machine selection and hide obsolete manual scope setup for target-aware plugins.
- Give plugin command results a dedicated tool page, readable/resizable output, Copy and Clear controls. Render UUID/text results without their JSON wrapper and prevent the plugin detail layout from collapsing their height.
- Cancel pending host tool approvals as well as the plugin-side wait when an assistant is stopped.

### Documentation

- Rewrite the README around the current workbench, platform downloads, independent marketplace and assistant setup. Refresh settings, architecture, plugin API, security, troubleshooting and optional-helper documentation, including runtime consent and actual validation limits.
- Document official Claude Code and Codex VS Code extension investigation, source/license findings and why arbitrary VSIX packages require a separate compatibility host.

## [0.24.1] - 2026-11-02

### Added

- A macOS-only General setting to keep or hide the Dock icon while the closed window runs in the background. It defaults to visible, supports settings profiles and import/export, and restores Dock presence when the window is reopened.

### Fixed

- Reopen and focus the retained main window when clicking the macOS Dock icon after closing, hiding or minimizing it. Tray actions and relaunching use the same restoration path while preserving SSH sessions and unsaved drafts.

## [0.24.0] - 2026-11-02

### Added

- Shared CPU, memory, network and disk read/write timelines in the remote sidebar and monitor page, with timestamp-based spacing, labeled dashed scales, separate receive/send and read/write series, and mouse or keyboard sample inspection.
- Linux disk I/O sampling uses block-device counters without counting stacked devices twice, and handles device resets, removal and unavailable measurements.

### Fixed

- Keep slow remote folder loading and refresh status in the existing file-pane footer so file rows and scroll positions remain stable.
- Copy selected text from mouse-aware terminal applications such as Pi through user-triggered OSC 52 writes when copy-on-select is enabled. Preserve native selection text across TUI redraws and forward application copy shortcuts when appropriate; clipboard read requests remain unsupported.
- Refresh mounted command-history panes after successful recording, including rerun commands, without reloading unrelated hosts or changing history-recording consent.
- Size terminal grids within their actual padded content area. Terminal previews retain their sample scrollback even when SSH scrollback is disabled, and tab labels allow enough line height for descenders and CJK glyphs.
- Exclude guest CPU time from duplicate accounting in remote CPU usage.
- Create one shared draft before parallel release builds and pass its ID to every platform, preventing downloads from being split across duplicate drafts.
- Separate native helper caches by runner image to prevent incompatible Linux C libraries being restored across Ubuntu versions. Optional helper builds run independently of desktop publication.

## [0.23.0] - 2026-11-02

### Added

- Named settings profiles with one-click switching, snapshot updates, renaming and removal, plus native JSON import/export with validation and an import preview. Portable preferences include keyboard bindings and exclude hosts, credentials, plugin data, history and open tabs.
- A searchable keyboard shortcuts editor with key recording, context-aware conflict checks, unbinding and per-command or global reset. Workbench, file, editor and terminal commands share the same registry as the command palette.
- A lock button on each pane selects the default destination for newly opened pages while existing pages retain their location.

### Changed

- Approved plugins use a collapsed collection with nested permission groups and a bounded scrolling list.
- Native MCP/remote-runner helpers are distributed as separate Actions artifacts. Desktop releases contain application downloads and updater files; publication checks reject accidentally attached helpers.

### Fixed

- Ctrl/Cmd+Comma opens settings from terminal and text-input focus. Configurable shortcuts respect file-pane priority, input composition, native clipboard handling and terminal Control keys.
- Narrow pane headers keep tab close buttons reachable, place tabs below Windows window controls when necessary and reveal the active tab on resize.
- Activity icons toggle docked panels, retaining their location, split proportions and live view state. Moving sidebar panels preserves their width or height within available space instead of assigning an equal split.

## [0.22.2] - 2026-11-02

### Changed

- Codex, Claude Code and Pi use independent marketplace packages, activity views, configurations and conversation storage. Tunnelde AI now focuses on API connections, with existing CLI settings preserved for explicit migration.
- Chat panels use compact conversation controls and bottom composers with model, execution-location and approval menus. Codex adds recent conversations and an execution-location bar; Claude Code has its own brand layout and composer controls.
- Plugin chat configuration separates agent connections from independent API reviewers. Profile policies restrict each plugin to its supported agent protocol, and unsupported CLI read-only modes are explained before sending.

### Fixed

- Pane controls stay centered at the right of the tab strip without scrolling with tabs. Close-pane actions live in the pane menu, and splitting or closing panes restores keyboard focus.
- Docked plugin panels remove duplicate titles, and chat views remove the redundant refresh row while keeping recovery controls for errors.
- Radio menus support keyboard navigation, checked states, descriptive text and positioning above bottom-anchored controls.

## [0.22.1] - 2026-11-02

### Added

- Independent local and remote file-pane display preferences, clickable details headers, name and file/folder filters, and collapsible groups by type, modification date or initial. Each pane remembers its view and can restore the defaults.
- Pane-scoped Ctrl/Cmd+F filtering and Finder-style Command+Up/Down navigation and Command+Shift+Period hidden-file toggling.

### Fixed

- File selection, keyboard navigation and transfer targets follow the visible filtered and expanded list. Inline create/rename operations reveal their target without changing the other pane; fixed headers stay aligned with scrolling rows.
- Background refreshes preserve pending directory navigation, and asynchronous create/rename completion cannot overwrite another source or directory's edit state. F2 uses the selected item after deselection or context-menu changes.
- Terminal settings place the live preview inside its display/rendering subgroup, with explicit preview labeling and clearer category/subgroup hierarchy.

## [0.22.0] - 2026-11-02

### Added

- Dockable plugin chat panels with streamed Markdown, conversation drafts, model and CLI profiles, task recovery, four approval modes and native file/folder pickers.
- Scoped AI/MCP tool execution with plugin/client resource ownership, revocation, concurrent-edit checks, keyring secrets and bounded streaming local/SSH processes.
- Optional native MCP stdio bridge and durable remote agent runner for Windows, macOS and Linux. Remote deployment requires explicit runtime selection and uses a fresh user directory without changing system services.
- Host support for the independent Tunnelde MCP and Tunnelde AI marketplace plugins, including OpenAI-compatible Chat Completions, Responses, Anthropic, Gemini and structured Codex, Claude Code and Pi adapters.

### Changed

- Plugin view contributions can declare sidebar placement, controlled chat rendering and activity icons. Namespaced command IDs and minimum Tunnelde version requirements are validated.
- Plugin tool approvals preserve complete operation details with scrollable monospace previews; password fields hide provider credentials.

## [0.21.1] - 2026-11-02

### Changed

- Settings use inline subgroups for appearance, workspace, terminal and files, with nested navigation within the existing category. Group names participate in bilingual search, and switching categories restores the top of the page.
- Theme customization uses nested spacing, guide lines and stronger group headings to distinguish presets, custom colors and individual workbench/terminal controls.

### Fixed

- Built-in and plugin palettes now update the global surface tokens used by dropdowns, dialogs, context menus, native controls and other overlays. Region-only overrides stay isolated, and color previews, resets and user CSS preserve their existing behavior.
- Terminal grid remainders no longer expose xterm's black viewport background at the bottom of previews and connected terminals, in both automatic and compatibility rendering.

## [0.21.0] - 2026-11-02

### Added

- A plugin marketplace with official and custom HTTPS catalogues, publisher/source details, search, installed/update filters, offline catalogue caching, cancellable native downloads and checksum verification. Manual updates bind to the original source and restore the previous package if replacement fails.
- Three independent official plugins: JSON formatting/minifying with numeric precision preserved, Unix timestamp/date conversion and batch UUID v4 generation. Declarative plugin forms accept input and show explicitly copyable results without evaluating plugin HTML.
- On-demand Node setup with explicit consent before using an existing system executable, manual executable selection and private Node 24 LTS installation. Node is not bundled; private installations do not modify PATH or shell configuration, and system-runtime consent can be revoked.
- A full HSV color picker with HEX/RGB entry, keyboard controls, live preview, Apply/Cancel and default reset. Custom colors cover individual workbench regions, terminal background/foreground/cursor, the accent and host markers, and are shared across light and dark themes.
- Compact built-in theme palettes with collapsed regional customization. Plugins can contribute one or more named themes; the data-only Studio Themes pack supplies dark and light palettes without requiring Node or running code.
- An independent `TunneldeDev/tunnelde-hub` marketplace repository with reproducible packages, catalogue validation, contribution workflows and a dependency-free plugin SDK.
- A versioned host API for settings, hosts/groups, SSH commands, terminals, local/remote files, monitoring, history, workspace layout, clipboard, notifications and plugin-scoped storage. Per-plugin approvals bind to package content and declared permissions.
- Restricted mode in settings and through `--safe-mode` / `--restricted-mode`, immediate authorization revocation, cancellation of pending API calls, and recovery guidance after plugin failures or abnormal exits.
- Dockable Hosts, Plugins and Trusted Hosts panels with tab grouping, four-edge splits and preserved search/scroll state.

### Changed

- Plugin lists open reusable workspace detail tabs. Plugin sources and runtime choices are managed separately from appearance resets; existing plugin views and API v1 remain compatible.
- Context menus and overflow menus group actions with separators and support keyboard navigation, measured placement and predictable focus restoration.
- Removed repeated license/copyright headers from first-party source files; the repository LICENSE and third-party notices remain.

### Fixed

- Custom accent colors now apply to all accent tokens. Region resets remove persisted overrides, and terminal color previews preserve the existing terminal and connection.
- Plugin operations isolate pending actions, reject package identity/source mismatches, and recover interrupted package replacements at startup.
- Download confirmations close before long operations so progress and cancellation remain reachable. Plugin protocol reads are bounded and timeouts cover blocked writes as well as replies.
- Terminal table borders now use Unicode grapheme widths for Chinese, emoji and joined sequences; streaming UTF-8 decoding preserves characters across SSH packets.
- Plugin READMEs render Markdown, GFM tables, lists and code blocks safely without executing HTML or automatically fetching remote images.
- Windows test executables embed the same Common Controls v6 manifest as the application, fixing the missing `TaskDialogIndirect` entry point before test startup.

## [0.20.0] - 2026-11-01

### Added

- Searchable settings with bilingual keyword matching, a modified-only filter, platform-aware default/range hints, and individual, category and full resets. Numeric drafts validate before saving; custom CSS drafts survive category switches.
- Live terminal settings for scrollback, line height, active/inactive cursor shape, blinking, scrolling, copy-on-select, right-click behavior and automatic/DOM rendering, with a local preview.
- Workspace controls for status-bar visibility, startup restoration, host activation, animation preference and monitoring interval. Hosts select on single click and activate on double click or Enter.
- File-view controls for hidden entries, folders first, natural name/size/date sorting and direction, plus editor wrapping, tab width and spellcheck preferences.

### Changed

- Fresh installations follow the system language and theme, use bundled Fira Code at 14 px, keep monitoring closed, and use compact window controls on Windows and native title bars on macOS/Linux. Existing saved preferences are retained.
- Directory preloading now warms the parent and the configured number of children through a shared queue of two requests, prioritizes foreground navigation and discards stale results.

### Fixed

- Terminal preferences update existing sessions without reconnecting or clearing output. Font changes wait for loaded fonts before measuring and coalesce resize/redraw work.
- Hidden files remain part of collision checks; selection, keyboard navigation and batch actions follow the displayed sort order. Newly created hidden items reveal themselves, and new-item editing scrolls to the correct row.
- Numeric preference resets clear invalid drafts, settings saves expose pending/error state, and editor display preferences preserve unsaved text and line endings.

## [0.19.1] - 2026-11-01

### Fixed

- Packaged terminals now load xterm's runtime styles correctly. Tauri's generated style nonce previously blocked ANSI colors, character-grid styles, cursor rendering and scrollbar colors in production while development builds appeared normal.
- Terminals use xterm's WebGL renderer for accelerated drawing and continuous box graphics, with automatic DOM fallback when WebGL is unavailable or its context is lost.
- Terminal copy and paste use the native clipboard, including right-click actions, Ctrl/Cmd+V, Ctrl/Cmd+Shift+V and Windows/Linux Insert shortcuts. Multiline paste respects bracketed-paste mode; Ctrl+C copies a selection and still interrupts the shell without one.
- Shell shortcuts such as Ctrl+K, Ctrl+N, Ctrl+B, Ctrl+W and Ctrl+\ remain available inside terminals. SSH output waits for both frontend listeners, and rejected PTY or shell requests report a connection error.
- Activity-bar entries consistently switch between persistent Hosts, Trusted Hosts and Plugins sidebars without changing editor tabs. Settings remains a separate bottom entry; redundant Home and settings subpages have been removed.
- Sidebar headings, search fields and editor borders align without a spacer gap. Divider drags persist their final size and handle cancelled or lost pointer capture correctly.
- The official SDK Hello example is removed from the production marketplace, including stale remote catalogs. Plugin installation can recheck the same package and immediately reflects successful installs even if a subsequent refresh fails.

## [0.19.0] - 2026-11-01

### Added

- A workbench with an activity bar, nested editor groups, four-edge tab splitting, draggable dividers and persistent layouts. Moving tabs preserves terminal output and unsaved editor drafts.
- Inline file and folder creation, rename, keyboard navigation, path focus, selection reveal and file/folder drag transfers between local and remote panels.
- A dedicated trusted-hosts page, host drag ordering, richer host context actions, private-key file/content selection and tag suggestions.
- Plugin installation from a ZIP archive or folder picker, native drag-and-drop and a manifest preview before installation.
- System and compact title-bar options adapted to Windows and macOS, a simplified host sidebar, and quick terminal font selection with bundled Fira Code.

### Fixed

- File creation no longer truncates existing files. Copy, move and transfer operations require explicit overwrite approval, reject incompatible destinations and retain sources on failure or cancellation.
- Deleting a remote directory symlink removes the link without traversing its target. Copies and transfers reject symlinks.
- Remote text saves correctly truncate shorter contents; unsupported text encodings are rejected instead of silently replacing bytes. Saving preserves edits made during a pending save, and disconnecting retains drafts with conflict checks on reconnect.
- Closing the window asks before discarding unsaved editor drafts; closing to the tray keeps drafts and sessions alive.
- Drag routing, tab ordering, long-name layout, icon alignment, dialog focus, dropdown keyboard behavior and Chinese input in tag fields now follow consistent interaction rules.
- System language follows the operating system's preferred UI language. Terminal initialization preserves early output and correctly applies ANSI colors, themes and monospace fonts.
- Directory refreshes, connection state, plugin operations, settings writes and layout persistence reject stale results and preserve later changes.
- Remote and local monitoring pause while hidden, share samples and avoid overlapping requests. Recording raw terminal input in command history is now opt-in.
- Removed redundant application menus and repeated sidebar branding. Settings remain accessible from the activity bar.

### Changed

- Releases remain drafts until all platform builds, signatures and the updater manifest are present; version checks now include the Cargo lockfile.

## [0.18.1] - 2026-10-31

### Fixed

- The window keeps its normal frame and edge resizing; the experimental in-app title bar is withdrawn because restoring the frame broke resizing.
- The terminal also receives TERM as an environment variable, so shells that override it still report a colour-capable terminal.

## [0.18.0] - 2026-10-31

### Added

- Settings → General can draw the window buttons inside the app instead of the OS title bar, which removes the second bar on top; dragging the tab strip or the sidebar header moves the window and the edges still resize it.
- Settings → Files controls how many child folders the preload warms, and preloading is on by default.

### Fixed

- "Set up key login" now works when the password is already in the keychain instead of staying disabled.
- The sidebar header and the tab strip share the same height, so the top edge no longer steps between them.
- The right panel slides out and back with the same transition instead of popping open slowly and snapping shut, and it keeps polling only while visible.
- The expand and close buttons in the panel header sit together instead of being spread across the bar.
- Folders use a filled accent icon, so they no longer look like files.
- The terminal keeps its monospace grid, kerning and visible cursor even when the renderer's injected stylesheet is unavailable; ligatures and letter spacing are pinned to keep columns aligned.

## [0.17.0] - 2026-10-31

### Added

- Settings → Files gains "Preload parent and child folders": with it on, the panel warms the parent directory and the first few subfolders, so moving around is instant.

### Fixed

- Going up from a drive root such as `C:\work` lands on `C:\` instead of `C:`.

## [0.16.1] - 2026-10-31

### Fixed

- Terminal glyphs are measured after the webfont loads, and output that arrives during that wait is replayed instead of dropped.
- Dragging the sidebar or right panel keeps whole pixels and saves the width the drag ended on, so the panel no longer springs back with a validation toast.
- The file source picker lists one row per host instead of one per open session.

## [0.16.0] - 2026-10-30

### Added

- Plugins can ship as WebAssembly: the manifest selects the runtime, every call gets a fresh instance, and the module only sees one host function for logging.

## [0.15.0] - 2026-10-30

### Added

- Settings → Plugins lists a marketplace fed by `marketplace/index.json`; installing an entry downloads its archive, verifies the pinned SHA-256 in Rust and then unpacks it.

## [0.14.1] - 2026-10-30

### Changed

- The host sidebar is a single tab stop: arrow keys move the active host, Home and End jump to the edges, and Enter opens it.

## [0.14.0] - 2026-10-30

### Added

- File panels accept a multi-selection: Ctrl/Cmd+click, Shift+click and Ctrl/Cmd+A, with delete, transfer, cut, copy, paste and drag applying to every selected entry.

## [0.13.1] - 2026-10-30

### Fixed

- Dialogs keep the keyboard focus inside themselves while open and return it when they close.
- The file list tells screen readers which row is selected, and the toast dismiss button follows the UI language.

## [0.13.0] - 2026-10-30

### Added

- `Ctrl+K` opens a command palette that searches pages, host actions, updates, panel and theme toggles and tab commands.

## [0.12.0] - 2026-10-30

### Added

- Hosts in the sidebar can be dragged into the order you want; the order is stored with the host.
- The connect dialog can install Tunnelde's public key with the password you just typed and switch the host to key authentication, so the next connection is passwordless.
- Plugins install from a `.zip` archive as well as a folder; archives are unpacked safely and capped in size.

## [0.11.0] - 2026-10-30

### Added

- File panes can show this computer or any open session, so two servers can be browsed side by side.
- Dragging a file or folder between panes copies it, folders included, and moving inside a pane renames it.
- Renaming happens in the row, files can be created next to folders, and the keyboard drives the list: arrows, Enter, Backspace, F2, Delete and Ctrl/Cmd+C/X/V.
- Settings → Trusted hosts replaces the list that was buried in Advanced.
- A monospace font can be chosen, Fira Code ships by default, and `Ctrl+=` / `Ctrl+-` / `Ctrl+0` resize it.
- Tags are edited as chips and filter the sidebar; the host context menu copies the ssh command or `user@host`.
- A private key can be picked from disk or pasted, and is stored with owner-only permissions.
- The plugins dialog installs from a picked or dropped folder instead of a typed path.
- Settings → General can show the OS menu bar, which mirrors the app actions in the UI language.

### Changed

- The duplicate top bar is gone: the brand, settings entry and update notice moved into the sidebar and status bar.
- The app follows the OS language on first run instead of defaulting to English.
- Dropdowns use the app's own listbox, destructive actions are red and ask first, and icon buttons line up with their rows.

### Fixed

- The connect dialog no longer shows a "previous fingerprint" when the trusted key is unchanged.
- Host rows no longer clip their text, and an empty group shows "—" instead of the word None.

## [0.10.3] - 2026-10-30

### Fixed

- The file pane only offers Paste when the clipboard entry has somewhere to go, instead of silently doing nothing.

## [0.10.2] - 2026-10-30

### Added

- The connect dialog shows the previously trusted fingerprint when a host key changed, so the two can be compared before replacing it.

## [0.10.1] - 2026-10-30

### Added

- Settings → Advanced can open the data folder next to the existing logs shortcut.

## [0.10.0] - 2026-10-30

### Added

- `Ctrl+Shift+W` closes the focused pane when the editor is split, and each pane's strip has a close button.

## [0.9.1] - 2026-10-30

### Added

- A close button on each pane's tab strip once the editor is split.

### Changed

- CI checks that the English and Chinese catalogues share the same keys.

### Fixed

- Re-dispatching a release now fails fast when the tag already exists instead of half-bumping the version.

## [0.9.0] - 2026-10-30

### Added

- Folders can be copied, moved and deleted: copying and pasting a folder now copies its whole tree, and deleting a folder removes everything inside it.

## [0.8.2] - 2026-10-30

### Added

- Plugins can be installed from a local folder after the manifest is validated, uninstalled from the same list and reloaded when folders are added by hand.

## [0.8.1] - 2026-10-30

### Fixed

- Releases publish `latest.json` once after every platform finishes, so parallel builds no longer fail with a missing-asset error.

## [0.8.0] - 2026-10-30

### Added

- Cut, copy and paste for files from the context menu or with Ctrl+X, Ctrl+C and Ctrl+V: cut moves, copy duplicates, and pasting across panes uploads or downloads. Folders are not pasted yet.

## [0.7.1] - 2026-10-30

### Added

- Tab context menu with close, close others, split right, split down and close pane.
- Host context menu with open, edit, favorite and delete.
- `Ctrl+\` splits the active tab to the right, `Ctrl+Shift+\` splits down; `Ctrl+W` now asks before discarding unsaved edits.

## [0.7.0] - 2026-10-30

### Added

- Split view: drag a tab to the edge of the editor area to open it in a second pane, drag tabs between panes to move them and close a pane to merge its tabs back.

## [0.6.0] - 2026-10-30

### Added

- Drag files between the local and remote panes to upload or download them, or inside a pane to move them into another folder.
- Right-click menus for files with open, transfer, rename, copy path and delete; the browser menu no longer appears.
- `pnpm build:local` builds an installer without the updater signature for local testing.

### Changed

- The embedded WebView no longer shows autofill suggestions, password bubbles, page context menus, browser shortcuts or devtools in release builds.

### Added

- Plugins can declare views and answer `view.render` with JSON blocks (heading, text, key/value, table) that the host renders in a tab.

## [0.5.3] - 2026-10-30

### Added

- Monitor tab with live CPU, memory and network charts, plus average and peak values for the session.

## [0.5.2] - 2026-10-30

### Added

- Settings → Advanced lists the trusted host keys and can forget them.

### Fixed

- Deleting a host also removes its stored password from the OS credential store.

## [0.5.1] - 2026-10-30

### Added

- Command history for every host, captured from the terminal, searchable and re-runnable from the History tab.
- Release automation: scripts bump every manifest, cut the changelog section and are wired into the Release workflow.

## [0.5.0] - 2026-10-30

### Added

- Plugin host: folders with `tunnelde-plugin.json` and an entry script, spawned as separate processes.
- JSON-RPC 2.0 over stdio with newline framing, initialize handshake, command calls, timeouts and log forwarding.
- Settings → Plugins lists manifests, starts and stops plugins, runs their commands and shows the last result.
- Minimal `hello` example plugin under `examples/plugins/hello`.

### Security

- Manifests validate ids, API version and permissions, and the entry script must stay inside the plugin folder.
- Each plugin runs in its own process and is killed when dropped.

## [0.4.2] - 2026-10-30

### Added

- Remote text editor: open a file from the files pane, edit it in place and save with Ctrl+S.
- Dirty tabs show a dot and ask before closing without saving.
- Binary files and files over 2 MB are rejected with a clear message.

## [0.4.1] - 2026-10-30

### Added

- Process list for the active session with pid, CPU, memory and RSS, plus a confirmed SIGTERM action.
- `TUNNELDE_DATA_DIR` to run Tunnelde against a throwaway profile.

### Changed

- Favorite hosts appear once in the sidebar instead of being repeated in their group.

## [0.4.0] - 2026-10-30

### Added

- Remote panel for the active SSH session with CPU, memory, disk, network rate, load and uptime.
- CPU sparkline and the five busiest processes, refreshed every three seconds.
- The panel falls back to the local machine view when no session is active.

## [0.3.0] - 2026-10-30

### Added

- Dual-pane file manager over the active SSH session with local and remote listings, path navigation and refresh.
- Folder creation, rename and delete in both panes, with confirmation before deleting.
- Streamed upload and download with progress, cancellation and a transfer strip.
- Files entry points on the host page and in the terminal toolbar.

## [0.2.1] - 2026-10-30

### Added

- Remember SSH passwords in the operating system credential store and reuse them from the connect dialog.
- Forget a saved password without leaving the dialog.

## [0.2.0] - 2026-10-30

### Added

- SSH sessions over russh with password and private-key authentication, PTY resize and framed terminal data.
- Trust-on-first-use host keys stored in SQLite, with a fingerprint prompt and a changed-key guard.
- xterm.js terminal tabs that keep their buffer while switching, with light and dark palettes.
- Connect dialog that reads the host key before credentials and offers to trust or replace it.
- Per-session disconnect that closes the tab and records the host as recently used.

### Changed

- Terminal tabs close themselves when the remote session ends.

## [0.1.0] - 2026-10-30

### Added

- Tauri 2 desktop shell with a React 19 workspace: tab strip, host tree, system panel and status bar.
- Host and group library stored in SQLite, with favorites, tags, notes and per-host colors.
- Settings for language (Chinese and English), theme, accent, density, text size and custom CSS.
- Custom CSS engine with import, export, validation and one-click reset.
- GitHub Releases updater: capability matrix, progress events, skip version and manual fallback.
- Tray menu, single-instance handling, window state restore and daily rotated logs.
- CI for the frontend and Rust crates, release automation with `latest.json`, and repository hygiene checks.
