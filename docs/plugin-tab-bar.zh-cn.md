# 标签栏扩展

插件通过 `host.tabBar.set(item)` 注册原生**按钮、下拉选择和文本**控件，
通过 `host.tabBar.remove(id)` 移除。目前接口为实验状态，应先用
`host.describe()` 检测支持情况。宿主统一处理渲染、焦点、主题和尺寸，不接收
HTML、CSS 或脚本。内置面板通过 `useTabBarContribution(tabId, id, content, priority)`
使用同一个标签栏插槽；组件卸载自动注销，旧注册的延迟注销不会移除新控件。

```js
await host.tabBar.set({
  id: "execution-target",
  kind: "select",
  title: "运行位置",
  command: "select-target",
  options: [
    { value: "local", label: "本机" },
    { value: "remote", label: "远端" },
  ],
  value: "local",
});
```

命令必须属于该插件的 manifest，且不能是编辑器或文件右键命令。按钮必须有命令；
文本不可执行命令；下拉选择需要命令、1–32 个值唯一的选项及有效的当前值。
调用命令时输入包含 `_tabBar: { itemId, tabId, tabKind, paneId, value }` 和 `_locale`。
上下文 ID 是不透明的提示信息，不授予权限；操作编辑器、文件或 SSH 时仍须调用
相应授权 API。更新下拉选择状态需要再次调用 `set`；命令失败时保留当前值。

省略 `when` 时只出现在插件自己的视图，包括停靠后的插件侧栏；`when: {}` 匹配
所有标签；`when: { tabKind: "editor" }` 匹配编辑器；
`when: { tabId: "sidebar:output" }` 匹配输出面板。多个条件按 AND 组合，点击时再次
校验。`disabled: true` 阻止执行。

ID 只允许 ASCII 字母、数字和 `._-`，最多 128 字节；标题及选项文字/值最多
128 个字符且不允许控制字符。优先级 -1000 至 1000，数值较大者在前，同值按 ID
稳定排序。每个插件最多 8 个控件，宿主最多 128 个。控件属于当前运行代次，停止、
崩溃、卸载或撤销授权后移除。每次更新都会更换宿主签发的点击令牌，旧点击会被拒绝。
WebView 重载后通过宿主快照恢复，无需重新启动插件；内部变更事件为
`plugin://tab-bar-changed`。

支持的图标名：`activity`、`check`、`alert`、`info`、`sync`、`terminal`、`cloud`、
`code`、`plug`、`copy`、`clear`、`folder`、`file`、`wrap`、`follow`、`play`、`pause`、`filter`。
错误包括 `plugin.tabBar.invalidItem`、`plugin.tabBar.unknownCommand`、`plugin.tabBar.limit`、
`plugin.tabBar.expired`、`plugin.tabBar.invalidContext` 及常规授权错误。

[English](plugin-tab-bar.en-us.md)
