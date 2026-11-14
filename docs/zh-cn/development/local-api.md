# 本地 API 与 CLI

有限稳定范围、数据生命周期和演进规则见
[兼容规则](local-api-compatibility.md)。

CLI 连接最多等待三秒；建立连接后，请求／响应收发总计最多十秒，零碎输出不会
重置总时限，每次写入另有三秒上限。写入发送后超时不证明宿主拒绝或回滚，应
先重读快照确认结果。协议客户端位于 `automation/client/`，与 CLI 参数解析、
输出和退出码处理分离。

接口发现的 `protocol` 字段提供公共请求／响应 Schema、错误码与 CLI 退出码，
来源为 `automation/schema/protocol-v1.json`。`x-maxBytes` 表示 UTF-8 字节上限，
独立于 JSON Schema 的 Unicode 字符数限制；消费者校验 Schema 时需要支持此
关键字，宿主始终执行该约束，仓库检查脚本已支持。

请求信封拒绝未知字段；响应信封、错误对象和端点描述允许新增元数据，但必须
保留字段类型、版本和请求 ID 对应关系，以及 `result`／`error` 恰好二选一。
CLI 忽略额外元数据并保留方法结果。该规则不允许删除或改变已有字段；方法
Schema 仍定义当前生产者允许输出的字段。端点另有回环地址、端口和凭据运行时校验。
宿主错误保留请求 ID，本地失败使用空 ID。未知错误码退出 1；格式或请求对应关系
错误返回 `invalid_response` 并退出 2。

本地自动化协议 v1 和明确声明的七个方法为 **stable**，其他应用及插件接口保留
各自的稳定状态。协议版本独立于桌面版本和插件 RPC 版本；协议编号不等于稳定
承诺。各方法提供 `stability` 和 `since`；七个稳定方法的 `since` 记录首次引入的
0.38.0-beta.1，而非稳定声明版本。实验方法未声明引入版本时可为 `since: null`；
应查询运行中宿主的接口发现确认可用性，不依赖应用版本推测。机器可读来源为
`src-tauri/src/automation/schema/v1.json`，并由
`automation/domains/` 下的适配器组合各领域已有的 Schema。

构建控制台程序：

```sh
cargo build --locked --manifest-path src-tauri/Cargo.toml --bin tunnelde-cli
```

安装后的桌面程序在 GUI 和单实例初始化之前，支持添加 `cli` 前缀执行相同命令：

```sh
tunnelde cli app info
tunnelde cli hosts list
tunnelde cli sessions list
```

Windows 使用 `Tunnelde.exe cli ...`，其他程序通过子进程管道可以读取正常的
stdout/stderr。交互式 Windows shell 若希望等待控制台进程，可使用独立的控制台
可执行文件。macOS 的桌面可执行文件位于 `Tunnelde.app/Contents/MacOS/`；Linux
使用已安装的程序或 AppImage，再添加 `cli`。

启动桌面应用后，也可以调用可选的独立控制台程序：

```sh
tunnelde-cli --help
tunnelde-cli --version
tunnelde-cli api describe
tunnelde-cli app info
tunnelde-cli hosts list
tunnelde-cli sessions list
tunnelde-cli preferences schema
tunnelde-cli preferences snapshot
tunnelde-cli call api.describe
```

帮助、CLI 版本及 CLI 自身的接口说明可离线使用。在线调用使用运行中应用的公共
业务服务，不单独读取数据库、不启动 WebView、不执行 shell，也不转发任意 Tauri
命令。核心发现、主机与会话方法仅提供读取，公共设置支持通过共享设置服务执行
修订检查后的更新。主机结果不包含备注、密钥路径或凭据，但包含地址
和用户名，请妥善处理输出。已保存主机列表不包含插件动态提供的主机。

在线成功结果向 stdout 输出一个 JSON 对象，包含 `version`、`id`、`result`；
失败向 stderr 输出 `version`、`id`、`error: {code, message}`。退出码为
0（成功）、1（操作失败）、2（输入或协议错误）、3（不可用或超时）、4（认证失败）、
5（修订过期）。
程序应根据错误码处理，不解析解释性消息。离线版本与接口说明直接返回 JSON 对象。
`call METHOD --params JSON` 接收一个对象，`--params -` 从 stdin 读取。
七个稳定方法中的读取方法只接收空对象；实验领域方法分别声明参数。
更新设置前，先通过 `preferences snapshot` 取得修订号，
审查需要修改的字段后提交：

```sh
tunnelde-cli preferences update --params '{"revision":"REVISION_FROM_SNAPSHOT","changes":{"appearance":{"theme":"dark"},"editor":{"tabSize":4}}}'
```

若 shell 不便转义 JSON，使用 `--params -` 从 stdin 输入。只修改提供的公共字段，
集合整体替换。未知字段和无效值返回 `invalid_preferences`（退出码 2），修订过期
返回 `stale_revision`（退出码 5）。应重新读取并审查变更，不要只替换修订号自动重试。
校验或提交失败不会发布设置；持久化和正常桌面副作用之间没有异步取消点，CLI
断开不会回滚已经提交的更新。修订号是不透明的非空字符串，最多 128 个 UTF-8
字节，不能包含控制字符。本地请求仍限制 32 KiB，不沿用插件较大的请求预算。
公共设置不包含代理密码、凭据、内部元数据和提供者选择，但可以包含用户 CSS、
代理地址和用户名，快照应妥善保管。本接口不会请求应用重启；延迟生效的设置沿用
普通桌面设置行为。存储迁移属于独立领域，不能通过 preferences.update 执行。

## 端口转发状态（实验）

`forwards.list` 复用原生转发管理器的已保存规则和运行注册表，无需打开终端或另建 SSH
连接。独立公开 DTO 和 Schema 位于 `automation/domains/forwarding/`。

```sh
tunnelde-cli forwards list
tunnelde cli forwards list --params '{"limit":20}'
tunnelde-cli forwards list --params '{"after":"上一页返回的ID","limit":20}'
```

结果包含 `entries` 和可空的 `nextAfter`。每条包含 `id`、`hostId`、`name`、不透明的
持久修订 `revision`、`direction`（`local`／`remote`）、`bind`／`target` 端点
（`host`／`port`）和 `state`（`running`／`stopped`）。运行表示宿主已登记监听器，
不保证目标服务可达；SSH 断开时由原有生命周期移除对应监听器。不返回运行身份、
会话 ID 或凭据。地址和规则名应妥善保管。只读接口不安装 helper、不请求凭据、
不启停或修改规则。

`limit` 为 1–128，默认 50，每页最多 64 KiB。将 `nextAfter` 作为下一次的 `after`
继续，直到返回 null。按规则 ID 的二进制升序读取；即使上一页末条规则被删除仍可
继续。这是实时分页而非冻结快照：编辑、删除和较早 ID 的新增会影响遍历，应省略
`after` 重新扫描以取得当前完整列表。继续位置不是授权凭据。空 `after` 从头读取；
其他 ID 最多 128 UTF-8 字节，不允许控制字符。SQL 限制读取条数和每条存储大小；
损坏记录明确报错，不静默遗漏规则。最多四个并发阻塞读取者，与日志读取名额独立。
取消停止后续读取，原工作实际退出前保留名额。无效参数返回 `invalid_request`
（退出码 2）；存储不可用、记录损坏或读取繁忙返回 `operation_rejected`（退出码 1）。
七个稳定方法和既有插件转发契约保持不变。

## 确认后修改转发（实验）

`forwards.save`、`forwards.remove`、`forwards.stop` 在运行中的桌面程序弹出原生确认。
弹窗说明请求来自本机程序，展示完整的新／旧规则，并警告可能允许其他设备访问的
监听地址。本地能力凭据并不能识别具体调用程序。最多保留一个此类确认，其他请求
直接报忙，不覆盖原弹窗；确认在 120 秒后过期。

```sh
tunnelde-cli forwards save --params '{"id":"dfe523d7-6893-4387-a609-b9f4ed1e0b23","hostId":"已保存主机ID","name":"数据库","revision":null,"direction":"local","bind":{"host":"127.0.0.1","port":15432},"target":{"host":"127.0.0.1","port":5432}}'
tunnelde-cli forwards stop --params '{"id":"规则ID","revision":"读取到的修订"}'
tunnelde-cli forwards remove --params '{"id":"规则ID","revision":"读取到的修订"}'
```

新建时由调用者生成新的标准小写 UUID，并显式传入 `revision: null`。提交事务要求
该 ID 不存在；重复请求不会覆盖已有规则。编辑时提交 `forwards.list` 中读取的 ID
和修订，以及完整规则字段。保存不会自动建立连接。编辑和删除要求规则已停止，
确认后提交时再次检查原修订与停止状态。

停止操作在确认前捕获原运行实例，提交时同时检查修订和实例。若用户等待确认期间
停止后重新启动，旧确认不能误停新实例。停止提交后网络清理有独立任务所有者，
调用方消失不会复活旧实例或中止已提交清理。

结果包含 `outcome`（`saved`、`removed`、`stopped` 或 `dismissed`）、`id` 和
`revision`。保存返回新修订；其他结果返回原审查修订，取消新建时修订为空。
修订或运行实例变更返回 `stale_revision`（退出码 5）；活动规则编辑／删除、无运行
实例、弹窗繁忙／过期及清理失败返回 `operation_rejected`（退出码 1）。报错并不
等于没有副作用；丢回复或超时后先观察当前状态，不要自动更换 ID／修订重试。
等待操作过期后迟到的弹窗回调不能写入。仅关闭 CLI 连接不会撤销仍待用户确认的
桌面请求。

接口不接受凭据、SSH 会话 ID、运行实例 ID 或跳过信任的参数。启动通过下述单独
请求流程接入正常的主机密钥和凭据交互。也可使用 `call forwards.save` 等通用 CLI
形式。这三个方法保持实验状态，不扩大七个稳定方法的兼容承诺。

## 转发启动回执（实验）

`forwards.start` 接受 `{id, revision, requestId}`，立即返回回执。`revision` 使用
`forwards.list` 读取的规则修订；`requestId` 是调用方新生成的标准小写 UUID。
CLI 成功退出表示请求已受理，只有 `running` 阶段表示监听已成功准入。

```sh
tunnelde-cli forwards start --params '{"id":"规则ID","revision":"读取到的修订","requestId":"ddc61387-4c72-4cc2-8a1a-5b153769e81b"}'
tunnelde-cli forwards start-status --params '{"requestId":"ddc61387-4c72-4cc2-8a1a-5b153769e81b"}'
tunnelde-cli forwards cancel-start --params '{"requestId":"ddc61387-4c72-4cc2-8a1a-5b153769e81b"}'
```

主程序先显示原生纯文本确认，列出捕获的主机、跳板、方向、端点和暴露风险；确认后
打开主机密钥与密码弹窗。公开参数不接受凭据、会话 ID 或信任绕过。连接目标变化
会使审核失效，重试不能悄悄改连别的地址。连接由主程序持有，独立于插件和用户
终端会话。同一审核主机／路由的规则可以共享连接；最后一条规则停止且待启动
操作释放引用后，连接自动清理。

阶段依次为 `consent`、`credentials`、`connecting`、`preparing`，终态为 `running`、
`dismissed`、`cancelled`、`expired` 或 `failed`。回执含原始输入、Unix 毫秒
`expiresAt`（待启动请求的截止时间，并非回执保留期限）及固定诊断键 `error`（或 null）。
`running` 只记录曾成功准入，当前
健康状态看 `forwards.list`。`cancelStart` 仅撤销待启动请求，不能停止已运行实例；
停止请使用另行确认的 `forwards.stop`。取消前已明确批准并保存的主机密钥不会回滚。

同一时间仅允许一个待处理交互；请求总期限 300 秒，原生确认 120 秒，主窗口心跳
15 秒。关闭弹窗、页面重载／丢失、过期或取消会阻止迟到的信任写入和监听准入，
并清理未公开的资源。终态回执在内存中保留 15 分钟，最多 128 条；满额时拒绝新
请求，不提前淘汰未过期回执。同一 UUID 和相同输入重放原回执，输入不同则拒绝。
程序重启不保留回执；回执未知不代表没有副作用，先查询 `forwards.list`，再决定
是否使用**新的** UUID 发起请求，禁止复用未知 UUID。凭据弹窗同时使用原生事件和
待处理查询投递，避免丢事件。三个接口均为实验状态，保持普通本地 API 的 10 秒
交换时限，不扩大稳定契约范围。

## 结构化日志读取（实验）

`logs.read` 复用插件使用的持久诊断／操作日志服务。机器 Schema 归属
`src-tauri/src/logs/read/schema.json`，由本地适配器组合进接口发现；不改变七个
稳定方法的基线或插件独立权限模型。

```sh
tunnelde-cli logs read
tunnelde cli logs read --params '{"filter":{"domains":["network"],"levels":["warn","error"]},"limit":50}'
tunnelde-cli logs read --params '{"source":"operations","limit":20}'
```

结果为包含 `entries`、`cursor`、`hasMore`、`reset`、`gap` 的结构化分页。每条记录
包含时间、级别、领域、可空插件 ID、消息、清理后的字段和截断标记，不返回 JSONL
原文，也不接受调用方指定文件路径。`filter` 支持精确的领域／插件／级别列表和不区分
大小写的文本匹配；不同字段取交集，同一列表内取并集。文本最多 256 个 UTF-8
字节；`limit` 为 1–200，默认 100，每页最大 128 KiB。

继续读取时提交返回的游标及相同来源、筛选器，可调整每页条数。`hasMore` 表示还有
可继续读取的有界数据，不是订阅；为 false 时可保留游标，稍后读取新追加的完整记录。
游标绑定本地读取者、应用进程、来源和规范化筛选器，不能复用插件游标。无效／不匹配
游标返回 `invalid_request`（退出码 2）；应用重启后应省略游标重新读取。

诊断日志从当前文件最近 256 KiB 内开始；操作日志最多覆盖最近保留的 1000 条。
轮换、截断、无效记录及保留范围造成的缺口通过 `reset`／`gap` 标记，未写完的尾行
等待追加；不承诺可靠审计或完整历史导出。本地最多四个并发阻塞读取者。请求超时后
停止后续扫描，原工作实际退出前继续占用名额。繁忙或存储不可用返回
`operation_rejected`（退出码 1），不暴露内部路径和异常详情。

同账户本地凭据允许读取应用及插件日志。共享服务会清理结构化字段，但自由文本、
主机信息和插件消息仍可能包含私人数据，输出与保存的分页应妥善保管。该方法不会
启动插件、取得插件授权、修改日志配置或执行命令。

桌面程序监听随机 IPv4 回环端口，在标准应用数据目录生成 `automation.json`。
这个入口文件仅包含路径。随机凭据和地址存放在另一个私有目录中，Unix 使用
0700 权限，Windows 在创建时设置仅当前用户可访问的受保护 DACL。每次启动更换
凭据，日志不会记录凭据。同一账户下能读取这个目录的程序可以调用接口；这不是
针对同一用户下其他程序的沙箱。

隔离应用标识、`TUNNELDE_DATA_DIR` 或自定义环境可使用 `--endpoint /absolute/path/to/automation.json`
或 `TUNNELDE_ENDPOINT`。默认使用 `dev.tunnelde.app` 标识，Windows 位于
APPDATA 下，macOS 位于 `~/Library/Application Support` 下，Linux 位于
XDG_DATA_HOME 或 `~/.local/share` 下。不支持远程监听和网络认证模式，双方都检查
回环地址。不要公开凭据文件或将其复制到其他机器。

通信使用每条 TCP 连接一个以换行结束的 JSON 请求，包含 `version`、`id`、
`token`、`method`、`params`。最多八条并发连接，服务端默认时限 10 秒，请求最大
32 KiB，响应最大 4 MiB。超额连接直接关闭，CLI 报告不可用。未知方法和多余参数
明确报错。接口不依赖 WebView 是否显示；启动接口失败会写日志，不影响桌面启动。
只有准确的 `forwards.save/remove/stop` 方法将认证后执行时限延长到 135 秒，CLI
收发总时限延长到 150 秒；其请求分帧和认证仍需在十秒内完成。其他方法、未知
方法名和未认证连接不延长时限。

正常服务结束会清理入口文件。强制终止进程可能留下失效的私有目录，其旧凭据不能
认证新进程。公开安装包和升级验收仍是交付门槛。桌面 CLI 入口属于现有桌面程序；
独立的 `tunnelde-cli` 在确定单独分发策略之前，作为可选源码构建提供。

可复现的公开 Windows 安装器数据保留检查及其边界见
[安装器验收](installer-acceptance.md)；应用内 OTA 与其他平台仍需独立验收。

## 归属与兼容

`automation/contract.rs` 管理请求、响应和错误，`schema/` 管理接口发现，
`domains/` 管理独立公共数据结构，`transport/` 管理认证、发现与通信边界，
`cli.rs` 管理参数、输出和退出码。业务逻辑保留在公共应用服务中，UI 状态和数据库
内部结构不是公共契约。

稳定基线为 `tests/fixtures/local-api/stable-v1/declaration.json`，包含独立发现
Schema 和保持不变的历史夹具摘要。CI 对实际生产者输出校验该基线；历史 CLI
行为、打包程序及安装升级数据保留仍是发布检查，Schema 相等本身不足以验收。
新增写方法必须
复用已有校验、授权、修订号及变更通知，不得另建持久化路径。
