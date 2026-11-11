# 可信前端插件

[English](plugin-ui.en-us.md) · [扩展架构](plugin-extension-architecture.zh-cn.md)

实验性 UI SDK 独立于 RPC 的 `apiVersion: 1` 进行版本管理。
`extensions.describe().frontend` 返回其版本、信任模型、组件和限制。
市场 SDK 提供 `tunnelde-ui.d.mts`，从宿主公开契约生成，不暴露内部状态仓库或组件源码路径。

前端命令也可以贡献[主机菜单操作](plugin-host-menu.zh-cn.md)。

## 契约文件分类

公开类型位于 `src/lib/extensions/contracts/<领域>/`，运行资源、公共组件、搜索、
前端生命周期、工作台、文件、终端、历史和转发分别管理自己的声明。实现及内部状态仓库不放入
公开契约目录。既有 `uiSdkContract.ts` 仅保留兼容类型导出，内部使用方直接引用领域文件。

市场 SDK 将同一依赖图镜像到 `sdk/ui/<领域>/*.d.mts`。原有 `tunnelde-ui.mjs`
类型导入仍可使用，也可直接引用 `sdk/ui/terminal/surface.mjs` 等领域入口。
这些只是类型声明，并非新增的运行模块；激活时仍由宿主传入 SDK 实例。

同步检查覆盖每个可达公开文件，拒绝私有类型或运行时代码导入、循环依赖、未导出的契约
和遗留生成文件。历史类型样例验证旧入口与领域声明的双向赋值兼容性，并明确检查
新增实验性目标带来的联合类型扩展；历史样例保持原样。UI SDK 仍为实验性 0.1.0，
不将其提升为稳定，也不改变 RPC 方法名。

## 清单和模块

纯前端插件不需要 Node。既有 Node、WASM 和声明式插件也可以增加相同的 `frontend`
声明，保留原后端；组合运行时仅对前端处理的命令增加 `frontend: true`。

```json
{
  "id": "custom-view",
  "name": "Custom view",
  "version": "1.0.0",
  "apiVersion": 1,
  "runtime": "frontend",
  "frontend": { "entry": "ui/index.mjs", "sdk": "^0.1.0" },
  "permissions": ["ui.trusted"],
  "commands": [{ "id": "hello", "title": "Hello" }],
  "views": [{ "id": "main", "title": "Custom view", "kind": "component" }]
}
```

`ui/index.mjs` 导出 `activate(context)`，只能注册清单声明的视图和命令 ID。
激活成功后才显示视图。注册返回可重复调用的释放函数，激活可以返回可选清理函数。

```js
export function activate(context) {
  const React = context.sdk.react;
  const { Button } = context.sdk.components;
  function Counter() {
    const [count, setCount] = React.useState(0);
    return React.createElement(
      Button,
      {
        onClick: () => setCount((value) => value + 1),
      },
      `Count ${count}`,
    );
  }
  context.views.register("main", Counter);
  context.commands.register("hello", () => ({ text: "Hello" }));
}
```

必须使用宿主提供的 React，不要在插件中打包第二份 React、React DOM 或 JSX 运行时。
构建 JSX 时使用经典的 `React.createElement` 转换，并从 `context.sdk.react` 获取 React。
相对 ESM 导入可以加载已批准的其他 `ui/` 资源。入口使用 ASCII 字母、数字、`.`、`_`、`-`
和 `/`，以 `ui/` 开头、`.mjs` 结尾，禁止空路径段、`.` 和 `..`。

公开宿主组件包括 Button、IconButton、Field、Input、Textarea、Switch、SearchField 和
EmptyState，继承宿主主题。SearchField 预设与应用统一使用强制 `@field:value` 筛选语法。
公开 SDK 类型描述组件参数、资源作用域及前端上下文。自定义 CSS 应限定选择器范围；
此版本不隔离 DOM 或 CSS。

## 信任与生命周期

批准提示明确说明前端代码共享宿主 JavaScript 上下文，可以绕过 SDK 包装访问 DOM 和原生桥。
这是可信代码，不是沙箱。停止后会清理宿主管理的贡献并撤销模块地址与 SDK 调用，
但无法撤销任意 DOM 修改、强制打断死循环或移除已执行的 JavaScript。
需要阻止插件执行时，可使用 `--safe-mode` 或 `--restricted-mode` 启动恢复。

宿主在同一次读取中计算包摘要并捕获资源字节，批准与摘要、运行代次绑定；修改已安装文件
需要重新批准。停止、权限变化和 WebView 销毁都会撤销本地协议地址。每个插件资源限制
8 MiB，最多 16 个所有者合计 32 MiB；快照和协议请求另有并发限制。
资源使用明确的 MIME 白名单，不提供 HTML 文档。生产 CSP 允许插件本地模块协议，
不开放任意网络脚本或 blob 脚本。

`context.resources` 管理清理和异步工作。打开模块、导入及激活各有 15 秒超时，SDK 调用
和命令有 60 秒超时。取消会及时结束等待并清理晚到资源，但不撤销原生或远端副作用。
插件应响应 `context.signal`，清理定时器、事件监听等资源。

`context.api.call` 使用既有 RPC 分发、权限、输入输出限制及异步完成后的授权检查。
前端命令仍通过既有发现和快捷键机制调用。激活及渲染错误写入软件日志；激活失败时
停止插件，组件视图提供刷新恢复入口。

引擎显示 `running` 不代表前端模块已经就绪。命令与 JSON 视图渲染会等待原生初始化
及前端激活确认，最长 15 秒，等待时不占用实例锁。每次调用绑定原运行身份；
停止、更换实例或重新打开前端模块会使未完成结果失效，即使关闭与重新激活都发生在
下一次通知处理前，也不能接受旧结果。取消一个就绪等待者不会停止其他调用者正在等待的运行。
普通视图刷新不弹出授权或 Node 设置窗口，显式交互操作仍检查授权。
既有 JSON 视图数据格式与公开 SDK 方法签名保持不变。

同一已准入运行的并发启动共享初始化和前端激活。原生启动请求尚未返回时，宿主就会
请求加载前端，握手就绪后才返回成功。完整启动采用固定的 45 秒截止，其中前端就绪
等待最长 15 秒；后来的调用者不能延长截止。取消一个启动等待者不影响其他等待者；
取消最后一个未完成等待者时，会退休此次新建的运行并等待本地进程退出。
已经运行的实例保持运行。这不代表远端或挂载资源的清理也已完成。

启动协调最多保留 64 个未完成操作、合计 256 个等待调用，每操作最多 32 个等待调用。
清理结算前保留操作容量，清理失败则隔离该操作。共享错误保留原错误代码和兼容性详情。
前端激活监听器由 bootstrap 管理，只能加载指定的已准入运行，不能批准或启动插件。

登记运行之前，宿主会重新读取安装目录中的清单，与已加载的元数据比较，并校验批准的
包内容。宿主先检查应用和 UI SDK 的版本范围、编译缺失的 WASM 模块，或准备所选的
Node 运行时，再进入激活。预检失败不会新建运行或使原授权失效。创建进程前还会再次
检查 Node 选择和系统运行时同意状态；已有的 Node 进程会直接复用，不重新探测可执行文件。

引擎初始化持有共享包读锁，安装、替换、卸载与重新扫描持有独占写锁；等待前端就绪前
会释放读锁。替换与卸载会等待本地子进程退出。重新扫描若无法确认进程退出，会保留
原引擎实例并记录失败，不会直接替换实例表。

此 SDK 提供组件视图、命令，以及显式选择的主机列表和工作台提供者。全领域服务迁移尚未完成。

界面替换及恢复流程见[界面提供者](plugin-ui-providers.zh-cn.md)。其余领域服务和依赖管理仍在实施。

## 端口转发表现提供者

组件视图声明 `provider: "forwarding"`，并声明 `ui.trusted`、`hosts.read`、
`forwards.read` 权限，由用户在设置中选择。`props.forwarding` 仅对应原生面板
当前选择的已保存主机；动态来源主机须先保存为普通主机。公开类型位于
`contracts/forwarding/entry.ts` 与 `provider.ts`；私有桥接位于
`extensions/forwarding/`，原生组件、状态、动作和契约保留在转发领域目录。

先读取 `snapshot`，再调用 `read({ revision: snapshot.revision, offset })`。
每页最多 128 条不可变记录、65536 个 UTF-16 文本单元。保留的快照仍可读取，
动作要求主机与修订仍为当前状态。不暴露 SSH 会话 ID 或可变应用状态。
`runtimeId` 标识实际运行实例，陈旧的停止操作不能停止替代实例。

可选的 `Entries` 只能挂载一次，复用原生规则列表。省略它不会卸载宿主控制器
或编辑器。主机选择、添加/刷新、凭据和主机密钥确认、监听暴露警告、编辑、
删除确认及恢复入口仍归宿主所有。编辑时提供者保持挂载但隐藏，收到
`visible: false`。通过 `capabilities.write` 判断是否展示写操作；
`forwards.write` 会在动作、延迟确认、认证完成和最终原生提交时重新检查。
完成与错误由后续快照体现，动作不承诺远端事务回滚。

`start`、`startAll`、`stop`、`requestAdd`、`requestEdit`、`requestRemove`、
`requestDisconnect` 仅操作已有规则或打开原生控件，不接受任意端点注入。
连接采用独立后台 SSH；未交付连接对其他面板隐藏，作用域关闭时清理。
已确认连接和监听可在切换表现后保留，但属于插件运行代次，撤权时关闭。
数据库中的已保存规则保留。切换离开再切回来不会复活旧作用域。
监听资源在最终授权提交前不能转发数据。

既有稳定 RPC 方法保持不变。新增实验性提供者会扩展发现与 Manifest 目标联合
类型；穷举旧目标的代码需处理未知目标。历史样例保持原样，检查仅允许明确的
新增导出与目标联合类型扩展。可信前端与宿主共享上下文和原生桥接，这些检查
不构成对恶意 JavaScript 的沙箱。

## 组合 UI 资源生命周期

通过 `extensions.describe().frontend.resourceScopes` 或
`context.resources.child` 检查实验性子作用域能力。成员为可选，保留旧 SDK
结构实现的兼容性。在已提交的 React effect 中为面板或订阅创建作用域，并在
该 effect 清理时释放：

```js
React.useEffect(() => {
  const scope = context.resources.child?.({ limit: 8 });
  if (!scope) return; // 旧宿主需由插件明确提供兼容处理。
  const timer = setInterval(() => { /* 刷新当前视图 */ }, 1000);
  scope.use(() => clearInterval(timer));
  return () => scope.dispose();
}, []);
```

子作用域继承模块取消；关闭时会关闭自己的后代，不影响兄弟作用域。移动或
隐藏保留的面板与卸载不同，只有 effect 真正结束才释放。React 开发模式重放
执行 effect 时应创建新作用域，不要复用已经取消的对象。

每个打开的子作用域占用父级一个额度。后代的工作和异步清理同时计入每一级
祖先，关闭后尚未完成的工作仍占额度；`size` 包含整个子树。取消和超时会立即
拒绝调用者，但不配合取消的操作仍须等到真实结果或失败结算后才释放额度。
迟到资源会被清理而不交付，异步清理完成前也不释放额度。超额或已关闭作用域
收到的已有资源仍会清理，并在清理期间计入额度。清理错误进入模块软件日志。
模块默认额度为 128；内部配置的作用域最多 4096。子作用域只能降低本地上限，
不能超过父级上限，后代深度最多 32。关闭的作用域不再接受新工作。

这是 JavaScript 生命周期，与 `resources.snapshot/release` 的原生所有权和
持久 runner 恢复分开。它不授予权限，不强制中断受信任代码，也不撤销远端
操作。仅关闭 UI 作用域不会停止持久任务或删除恢复记录；这些操作应使用明确
的原生生命周期与恢复接口。异步清理会被观察，但不是串行事务，也不代表进程
已经退出。

## 宿主管理的视图资源

声明 `frontend.viewLifetimes` 的宿主会在 `FrontendViewProps` 中传入可选
`resources`。每个实际挂载的普通插件视图或替代面板实例都有独立的模块子作用域。
旧宿主不传这个属性；兼容旧版时应检测能力并实现明确的降级。

```js
function View({ resources }) {
  React.useEffect(() => {
    if (!resources) return;
    const timer = setInterval(refresh, 1000);
    return resources.use(() => clearInterval(timer));
  }, [resources]);
  return React.createElement("div", null, "视图内容");
}
```

在 effect 或事件中登记资源，不要在渲染期间登记。effect 返回单项释放函数，
以处理依赖变化及 React 的 effect 重放。即使插件忘记释放，宿主也会在视图真正
卸载、渲染崩溃或运行代次退出时关闭其作用域。宿主挂载 effect 重放会分配新作用域，
关闭过的对象不会重新激活。

隐藏或移动仍保留挂载的内容会保留作用域；关闭后重新打开会创建新对象，同 ID 的
兄弟实例互不影响。更换提供者（包括一次批处理中 A → B → A）会关闭旧作用域。
更换绑定的终端、文件来源/会话、历史会话、转发主机、监控或进程会话也会更换该
提供者的生命周期；普通目录刷新及 `visible` 变化不会。只有保留实际 React 挂载
才能保留生命周期，导致实际卸载的布局操作仍会关闭作用域。

宿主仅在确认挂载后分配资源，核对准确的模块令牌、指纹和注册组件，并共享模块额度。
额度耗尽沿用错误提示与原生恢复入口，不重启兄弟视图。Workspace/Screen 的校验
在插件实际挂载后开始，原生 portal 所有者在选择和恢复过程中保留编辑器状态、
终端缓冲区和 SSH 连接。

`context.resources` 仍属于整个模块。`props.resources` 不自动接管原生句柄、
取消 RPC 传输或停止持久/后台任务。用 `run`、`acquire` 包装异步视图工作，拒绝
迟到交付并清理迟到资源；不配合取消的工作仍计入额度直到真实结算。原生资源的
退出应使用明确的所有权和恢复接口。
