# 本地 API 与 CLI

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

本地自动化 API 目前是**面向 1.0 的实验候选接口**。协议版本独立于桌面版本和
插件 RPC 版本；协议编号不等于稳定承诺。机器可读的唯一来源为
`src-tauri/src/automation/schema/v1.json`，并由
`automation/domains/preferences/schema.rs` 组合公共设置领域已有的 Schema。

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
读取方法只接收空对象。更新设置前，先通过 `preferences snapshot` 取得修订号，
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
`token`、`method`、`params`。最多八条并发连接，服务端时限 10 秒，请求最大
32 KiB，响应最大 4 MiB。超额连接直接关闭，CLI 报告不可用。未知方法和多余参数
明确报错。接口不依赖 WebView 是否显示；启动接口失败会写日志，不影响桌面启动。

正常服务结束会清理入口文件。强制终止进程可能留下失效的私有目录，其旧凭据不能
认证新进程。公开安装包和升级验收仍是交付门槛。桌面 CLI 入口属于现有桌面程序；
独立的 `tunnelde-cli` 在确定单独分发策略之前，作为可选源码构建提供。

## 归属与兼容

`automation/contract.rs` 管理请求、响应和错误，`schema/` 管理接口发现，
`domains/` 管理独立公共数据结构，`transport/` 管理认证、发现与通信边界，
`cli.rs` 管理参数、输出和退出码。业务逻辑保留在公共应用服务中，UI 状态和数据库
内部结构不是公共契约。

宣布稳定前需要冻结输入、输出及错误样本，对实际输出进行 Schema 校验，验证旧
CLI 与新宿主兼容，在支持的平台验证打包程序，并明确弃用规则。新增写方法必须
复用已有校验、授权、修订号及变更通知，不得另建持久化路径。
