# 公开安装器升级验收

**Public Windows installer upgrade** 工作流在一次性的 GitHub 托管 Runner
中安装两个已公开的 Windows x64 版本。下载精确的带版本号 NSIS 资源，执行前
检查大小与 GitHub 发布的 SHA-256。摘要校验用于确认下载完整性，不能代替更新器
的签名验证。

工作流启动旧版已安装的程序，通过真实应用服务写入设置、Profile、主机与分组、
命令历史，以及最小前端测试插件的审批与存储，再正常退出。随后在同一目录安装
新版，使用同一份隔离数据及 WebView 目录启动新版已安装程序，核对保留值、插件
指纹、权限、没有进入恢复模式，以及正常退出。

手动运行时填写公开版本标签 `from`、`to`；目标必须更新，Beta 仅支持 `.1` 至
`.9`。修改验收程序的 PR 也会运行一组固定的公开版本。不需要重新编译应用。
固定版本的 Playwright 客户端通过 CDP 连接已安装程序的 WebView2，不下载浏览器，
不修改产品 CSP 或二进制。
托管 Runner 以提升权限运行，使用临时、仅针对应用的 HKLM WebView2 调试和数据
目录策略，每次进程退出后清理，拒绝覆盖已有值。微软 WebView2 安全文档说明，
提升权限的进程会忽略用户级调试覆盖。

目标版本支持本地 CLI 时，可启用 `check_cli`，额外执行实际已安装桌面二进制的
离线版本与发现，以及全部七个在线方法，包括条件设置更新、陈旧修订写入被拒绝且
状态不变，以及恢复原设置。早于 CLI 的
历史版本保持关闭。

结果、安装器输出、应用日志和截图作为工作流产物保留 14 天，仅含合成测试数据。
即使指定不同安装目录，NSIS 仍会修改当前用户的软件注册信息，因此验收程序拒绝
在普通工作站或自托管 Runner 上执行，不应绕过此限制。

成功结果只证明指定安装器版本对的 Windows 数据保留场景，不代表应用内 OTA
交接、已保存凭据、物理 macOS/Linux 或所有历史升级路径均通过；这些仍需独立
验收。此工作流不发布软件，也不把实验 API 自动提升为稳定接口。

## macOS 与 Linux 公开 CLI 包

**Public packaged local CLI** 工作流按 Runner 实际架构选择精确的公开 macOS
Intel／Apple Silicon 应用归档或 Linux x64 Debian 包，检查发布大小及 SHA-256，
解包后执行该包内的二进制。Linux 使用独立虚拟显示与 D-Bus 会话。应用数据位于
一次性 Runner 的临时目录，应用与 CLI 子进程不接收 GitHub 令牌。

验收先在 GUI 启动前执行离线发现与版本查询，再启动桌面并调用全部七个本地方法，
实际更新一次设置，检查陈旧修订写入被拒绝并恢复原设置。结果与进程日志保留 14 天，
不重新编译软件，也不需要安装插件。

成功结果证明指定架构公开包能够执行并提供本地协议。解包测试不等于安装器注册、
Gatekeeper／隔离属性、物理硬件或应用内 OTA 验收。程序只终止自身创建的隔离应用
进程，清理不作为正常退出证据。Windows 安装与数据保留由前述独立工作流覆盖。

## Windows 应用内更新

**Public Windows in-app update** 工作流只安装起始公开版本，写入相同的合成数据，
随后使用普通 GitHub 更新源和目标渠道调用应用自身的更新检查与安装命令。选择的
版本必须与 `to` 完全一致，因此需使用该渠道当前可选的最新版本。包签名及签名
版本仍由应用内置公钥验证。验收程序不会自行安装或启动目标版本。

通过条件包括旧进程成功退出、更新器自动重启目标安装目录中的程序、原有数据与
插件审批保留且没有进入恢复模式，以及目标 CLI 正常工作。关闭重启后的窗口必须
让进程消失并移除本地端点。该进程不是验收程序的直接子进程，无法读取退出码，
结果会明确记录实际观察到的退出条件。禁止在用户工作站和自托管 Runner 执行。

产物包含更新选择、进度、日志、截图和启动／数据校验。成功只覆盖指定 Windows
公开版本对，不代表 macOS／Linux OTA、真实凭据或全部历史迁移路径。

OTA 使用一次性 Runner 的原生应用数据目录，开始前该目录必须不存在。NSIS 经
Explorer 重启，不继承验收进程的临时数据目录环境变量。起始及自动重启后的进程
必须报告相同的实际数据库位置；日志从报告位置采集。仅安装器测试仍使用临时目录。

## 一次性 macOS OTA 环境探针

**Public macOS OTA environment probe** 工作流是 macOS 公开包 OTA 验收的第一阶段。
它编译原生能力读取程序，检查托管控制台会话、显示器、辅助功能信任和屏幕捕获
预检；通过后才实际截取桌面。随后复用公开 CLI 包选择器，按实际架构选择公开
`v1.2.1`、`v1.3.0` 归档的元数据。它不下载、解包、启动、修改或更新应用。
探针成功**不代表 OTA 通过**，也不保证后续 GUI 驱动拥有相同的 TCC 身份。

在 `TunneldeDev/Tunnelde` 中从已审查分支手动运行，`acknowledgement` 输入
`probe-only`。GitHub 已注册该工作流后：

```sh
gh workflow run macos-ota-probe.yml --repo TunneldeDev/Tunnelde \
  --ref <reviewed-branch> -f acknowledgement=probe-only
```

新增工作流触发前先核实注册状态。若 GitHub 报告不可用，应保留响应并等待负责人
按正常流程集成；不要仅为启用探针而合并或发布。`--ref` 指向将执行的已审查代码，
无需选择默认分支。PR 在 Linux、macOS 和 Windows 上执行环境拒绝与资源选择测试；
只有 POSIX 所有权／mode／symlink 用例限制在 Linux／macOS，真实入口拒绝和上下文
用例在三平台均执行。macOS 另编译原生读取程序并检查 JSON 序列化，不调用图形 API。

手动作业固定使用 GitHub-hosted `macos-15`、只读 contents 令牌、不保留凭据的
checkout 和八分钟超时。入口在创建文件前检查真实系统、架构、账户与 home，
hosted／手动事件／仓库／工作流上下文、固定版本对，以及无符号链接祖先的规范
workspace／temp 路径。拒绝 root、自托管、其他仓库及普通工作站。这些检查用于
防止误跑；环境字符串不能证明恶意管理员没有伪造环境。勿在用户机器复制托管环境。

每次尝试新建仅所有者可访问的
`$RUNNER_TEMP/tunnelde-macos-ota-probe-<run-id>-<attempt>`；已有目录直接拒绝。
辅助命令有时间和输出上限。不启动应用或服务，不递归删除内容，清理由 Runner
销毁负责。即使能力检查失败，也上传 `evidence` 子目录并保留 14 天。
`results.json` 将探针结果与 `otaAttempted: false`、`otaAccepted: false` 分开，
`native.json` 保留能力观测。提前被环境门禁拒绝时不创建证据目录，具体断言保留在
作业日志。截图仍需实际审查。

读取程序调用 `AXIsProcessTrusted()` 和 `CGPreflightScreenCaptureAccess()`，
不请求授权、不修改 TCC、不调用 `sudo`、不改变系统安全策略、不安装常驻服务。
缺少图形／辅助功能／截图能力时作业失败，不以成功跳过代替。不能为绕过失败而
授予权限或重签公开应用；此时需要另一个已明确授权原生图形访问的一次性环境。

### 原始公开应用 GUI 检查

独立的 **Original public macOS GUI and OTA acceptance** 工作流实现后继检查阶段。
从已审查分支手动触发 `macos-public-ota.yml`，填写
`acknowledgement=original-public-ota`。`inspect` 模式检查控件与正常 Quit；
`upgrade` 模式尝试真实签名更新。
PR 检查验证归档拒绝、编译外部原生驱动，并确认在访问 GUI／Profile 前拒绝普通环境。

启动前驱动重新检查自身权限，要求一次性账户没有生产 bundle、原生应用数据／偏好／
缓存、既存应用进程或正式 service 的凭据条目。凭据查询不读取秘密，禁止认证弹窗。
不检查开发者机器的 Profile 或凭据库。

Runner 下载未改动的公开起始包，核对发布大小／SHA-256，验证全部归档成员后才解包，
并检查原始 plist、架构和代码签名。不注入代码、不覆盖数据目录、不向应用传入 GitHub
令牌；直接启动原始二进制后用 `lsof` 核实实际数据库位置，通过 stable CLI 写入合成
设置并检查七个 stable 方法。独立原生进程用有界 AX 遍历、唯一匹配 AXPress 和生成式
系统快捷键检查 Settings／Updates 并请求正常 Quit。这不属于物理键盘验收。

每次运行在
`$RUNNER_TEMP/tunnelde-macos-public-ota-<run-id>-<attempt>/evidence` 保留截图、AX 树、
源码／二进制摘要、命令结果，以及正常退出和强制清理的区别，上传后保存 14 天。
不上传端点 capability 或凭据值。失败停止仍拥有的 source 直接子进程；尝试更新后，
也清理 bundle 路径、用户、PID 与启动身份仍匹配本次的 updater target。
强制清理单独记录，Profile 由 VM 销毁清理。
`inspect` 模式的 `otaAttempted` 和 `otaAccepted` 均保持 false。

`upgrade` 模式将原始目标归档下载为不执行的对照。通过原生 GUI 保存命名设置 Profile
以及带随机密码的合成主机，密码保存在一次性账户凭据库，不进入参数或 AX 树。
凭据检查只读取条目的不透明持久引用并记录其 SHA-256，不读取秘密。
GUI 选择版本必须准确等于固定公开目标，之后才点击安装。Runner 不启动目标进程：
观察更新器自行重启，核实 PID／启动身份、安装后版本／代码签名／对照二进制摘要和
实际原生数据库位置；比较设置、Profile、主机、凭据条目身份、stable CLI 与正常 Quit。
重启进程不是 Runner 的子进程，只能记录退出观测，不能虚报退出码。清理信号要求
PID／启动时间、bundle 路径和用户身份仍一致。

`otaCoreAccepted` 仅表示上述实际更新／保留范围。非空历史、凭据实际认证／值保留、
插件指纹／授权／存储和活动恢复标记尚待验证时，完整 `otaAccepted` 保持 false。
阶段工作流通过不等于整个矩阵完成。原生 Profile 读取程序只以只读模式打开一次性
账户的规范数据库，不接受其他数据路径、不负责预置数据。

### 公开包 OTA 验收清单

公开应用验收程序已实现下列核心更新步骤，实际证据须与第一阶段能力探针分开。
完整数据验收仍需非空历史、凭据实际认证／值保留、插件指纹／授权／存储及活动恢复
标记；这些不包含在核心结果中：

1. 重跑 hosted 门禁，检查实际 GUI 驱动的能力。要求一次性原生 Profile 干净，
   没有既存 Tunnelde 进程、应用数据、偏好与应用凭据条目。公开 `1.2.1` 使用正式
   Keychain service，用户账户内只改数据目录或 plist 不足以隔离。不得检查真实用户凭据库。
2. 复用发布选择与 CLI 工具，下载对应架构的原始起始包和目标包。记录资源 ID、发布
   SHA-256／大小、独立计算的下载摘要、原 bundle 标识、plist 版本、二进制摘要、
   架构及 `codesign --verify --deep --strict` 结果。不重签、注入库、替换运行时代码，
   不放宽 TLS／更新签名。目标归档仅作对照，不由验收程序代替更新器安装或启动。
3. 将未改动起始 bundle 放入本次拥有且可写的安装目录，不向应用传入 GitHub 令牌。
   通过既有服务／CLI 写入合成设置、主机元数据和支持的存储，记录实际数据库／端点
   位置。使用一次性账户的原生 Profile，使自动重启无需继承临时数据目录覆盖。
   两个进程均核实实际位置，不能假定相同。
4. 使用真实 GUI 的检查与安装控件和普通公开 feed。选择版本必须等于 `1.3.0`；若
   当前选择其他版本，应停止并复核版本对，不固定假 feed 或降级。保存截图、下载／
   进度／错误日志，以及应用签名和原生包校验结果。只选择到元数据不足以结算。
5. 观察旧进程退出、更新器自动从同一安装路径重启，不能手动启动目标。核实新版本、
   原身份／签名、与参考包一致的二进制摘要、合成数据保留且未进入恢复模式。复用
   七个 stable CLI 检查，包括陈旧修订拒绝／恢复。仅记录实际可得的退出码；
   非子进程消失不等于取得退出码。
6. 从重启后的 GUI 正常退出，确认进程和端点移除，将正常退出与强制清理分别留证。
   等待有界，清理只针对 PID、启动身份和拥有 bundle 路径均匹配本次的进程；失败和
   未知结果保留至 Runner 销毁。上传合成结果／日志／截图，不上传端点 capability 或秘密。

分阶段工作流无需签名／发布密钥，不新增产品 API。CLI 成功、生成式 GUI 输入和
托管执行均不代替物理键盘／输入法、Gatekeeper 或完整历史迁移验收。

参考：GitHub [手动工作流触发](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_dispatch)
与 [Runner 变量](https://docs.github.com/en/actions/reference/workflows-and-actions/variables#default-environment-variables)；
Apple [辅助功能信任查询](https://developer.apple.com/documentation/applicationservices/1459186-axisprocesstrusted)
与 [屏幕捕获预检](<https://developer.apple.com/documentation/coregraphics/cgpreflightscreencaptureaccess()>)。
