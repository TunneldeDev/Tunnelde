# 界面提供者

[English](plugin-ui-providers.en-us.md) · [可信 UI SDK](plugin-ui.zh-cn.md)

[监控界面提供者](plugin-monitor-ui.zh-cn.md)可组合完整页与远端侧栏的共享图表及有界资源数据。

[文件浏览器提供者](plugin-file-browser.zh-cn.md) 还可以组合或替换实际文件列表。

实验性 UI SDK 支持由用户显式选择主机列表和工作台的替代界面。为组件视图声明
`provider: "hostList"` 或 `provider: "workbench"`，不设置 `location`，仍通过
`context.views.register` 注册。每个包最多声明八个提供者视图。两种目标都要求可信
前端；主机列表还要求 `hosts.read`。通过 `extensions.describe().frontend.providers`
检测宿主是否支持。

```json
{
  "views": [
    { "id": "hosts", "title": "主机卡片", "kind": "component", "provider": "hostList" },
    { "id": "desktop", "title": "工作台", "kind": "component", "provider": "workbench" }
  ]
}
```

用户在“设置 → 插件 → 界面提供者”中选择。安装、启动和注册插件不会自动替换界面。
选择前保留指纹审批和运行时授权；导入配置也不会授予插件执行权限。插件停止、缺失、
受限、撤权或失败时，显示内置界面，同时保留选择，直到用户还原或选择其他提供者。

工作台视图通过 `props.workbench` 获得共享的 `Workspace`、`Navigation`、`Inspector`
和 `StatusBar` 组件。首次渲染必须同步挂载一次 `Workspace` 并始终保留；其他区域可选，
每种最多挂载一次。使用普通 React 和 CSS 排布，不复制内部 store，不重建会话，不打包
另一份 React。宿主保留各区域的 React 所有者，把原有 DOM 移入提供者的挂载点。切换时
保留终端 DOM、编辑草稿、页面、窗格 ID 和分割比例。通过设置切换工作台前保存当前布局；
恢复时继续使用当前布局及用户后续调整，不以旧快照覆盖用户的新布局。

```js
function Workbench({ workbench }) {
  const { Workspace, Navigation, StatusBar } = workbench;
  return React.createElement(
    "div",
    { style: { display: "flex", flex: 1, flexDirection: "column", minHeight: 0 } },
    React.createElement(
      "div",
      { style: { display: "flex", flex: 1, minHeight: 0 } },
      React.createElement(Navigation),
      React.createElement(Workspace),
    ),
    React.createElement(StatusBar),
  );
}
```

窗口控制、权限/凭据/主机密钥弹窗、F1 命令、后台任务、日志和恢复栏继续归宿主管理。
可以点击恢复栏或在 F1 中执行“恢复内置界面”。渲染异常、遗漏或重复挂载工作区会自动
回退并记入日志，不循环尝试故障提供者；异步及事件处理器错误仍需插件自行处理。
可信代码与宿主共享上下文，React 错误边界无法隔离死循环、恶意 DOM 操作或原生桥滥用；
代码阻塞界面时应通过受限模式恢复。

本能力不代表全领域服务、依赖管理及跨平台验收已经完成；既有稳定 RPC 契约保持不变。
