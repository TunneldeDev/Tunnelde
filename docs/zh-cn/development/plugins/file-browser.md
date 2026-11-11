# 文件浏览器提供者

普通插件也可使用[浏览器实时数据与操作](file-browser-data.md)，无须注册替换界面提供者。

[English](../../../en-us/development/plugins/file-browser.md) · [界面提供者](ui-providers.md)

实验性 UI SDK 支持受信任前端组件声明 `views[].provider: "fileBrowser"`。
Manifest 必须声明 `ui.trusted`、`fs.read`、`sftp.read` 和 `workspace.write`。
用户在“设置 → 插件 → 界面提供者”选择；选择不会授予权限或绕过审批，插件不能自行启用。

宿主为每个面板提供 `FrontendViewProps.fileBrowser`。不可变 `snapshot` 包含面板身份、来源、路径、
修订号、可见条目数、选择、加载状态和错误。`read({ revision, offset? })` 每页最多 256 条，
遵循宿主当前筛选和排序，`nextOffset: null` 表示最后一页。每页必须使用对应修订号。
旧上下文保留不可变数据，但面板变更后不能派发操作。不暴露内部 store、缓存或凭据，读取仍检查提供者授权。

```js
export function activate(context) {
  const React = context.sdk.react;
  const { Button } = context.sdk.components;
  function Files({ fileBrowser }) {
    const { snapshot, Entries } = fileBrowser;
    return React.createElement(
      "div",
      {
        style: { display: "flex", flexDirection: "column", flex: 1, minHeight: 0 },
      },
      React.createElement(
        Button,
        {
          disabled: snapshot.busy || !snapshot.path,
          onClick: () => fileBrowser.refresh(),
        },
        `刷新 · ${snapshot.total}`,
      ),
      React.createElement(Entries),
    );
  }
  context.views.register("files", Files);
}
```

`Entries` 是可选公共组件。挂载一次即可组合现有列表，复用 Finder 分栏、选择、列宽、右键菜单及拖放；
实际 DOM 移动时不重建 React 所有者。自行渲染也可通过 `read` 分页读取，但须实现可访问的选择与键盘交互。

| 操作                    | 行为                                           |
| ----------------------- | ---------------------------------------------- |
| `navigate(path)`        | 请求导航，完成或错误通过新快照反馈。           |
| `refresh()`             | 刷新当前或正在请求的目录。                     |
| `select(paths)`         | 选择本修订的可见条目，重复或外部路径整体拒绝。 |
| `open(path)`            | 目录进入，文件通过宿主编辑器或预览打开。       |
| `open(path, "preview")` | 通过既有预览提供者预览可见文件。               |

请在挂载后的事件或 effect 中派发操作，不要在渲染期间调用。加载、关闭、修订变更、停用、撤权和替换均使旧操作失效。
原生文件系统与 SSH 校验继续生效。错误使用 `plugin.fileBrowser.invalid`、`plugin.fileBrowser.busy`、
`plugin.fileBrowser.changed` 或现有前端不可用错误。受信任 JavaScript 运行在宿主上下文，不是安全沙箱。

路径栏、来源选择、筛选、工具栏、状态与恢复入口仍由宿主管理；内联新建或重命名暂时恢复原生列表。
停用、卸载、受限模式或渲染失败恢复内置列表，保留所有者、导航、选择和列偏好。
既有文件 RPC、格式化、图标和预览扩展继续兼容。
