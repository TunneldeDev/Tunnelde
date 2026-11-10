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
