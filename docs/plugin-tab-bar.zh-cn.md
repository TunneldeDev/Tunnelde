# 标签栏扩展

插件通过 `host.tabBar.set(item)` 注册原生**按钮、下拉选择和文本**控件，
通过 `host.tabBar.remove(id)` 移除。两个方法具有稳定的 v1 契约，应先用
`host.describe()` 检测支持情况，并读取 `contract.inputSchema`、`resultSchema`、
`errorSchema` 和 `commandContextSchema`。方法自 0.32.0-beta.6 起提供，旧宿主
可能尚未声明稳定承诺；冻结的[标签栏契约](../tests/fixtures/plugin-compat/tab-bar-v1.json)
定义兼容性底线。`set` 返回 `null`，完整替换控件，省略字段恢复默认值。
`remove` 返回是否移除了当前运行代次拥有的控件，不存在时返回 `false`。
宿主统一处理渲染、焦点、主题和尺寸，不接收
HTML、CSS 或脚本。内置面板通过 `useTabBarContribution(tabId, id, content, priority)`
使用同一个标签栏插槽；组件卸载自动注销，旧注册的延迟注销不会移除新控件。

操作按钮统一使用 28 px 尺寸和应用主题，不同组之间使用细分隔线。
`placement: "leading"` 放在标签之前，默认 `"trailing"` 放在标签之后、窗格操作之前。
`group` 是插件作用域内的 ASCII 标识，同组控件保持相邻，优先级高的组先显示。
`showLabel: true` 让按钮同时显示图标和标题；`tooltip` 提供最多 512 字符的纯文本提示；
`checked` 提供按钮选中状态，`false` 同样会声明可访问的未按下状态。
命令完成后插件应再次调用 `set` 更新选中状态，宿主不会提前假定命令成功。

窗格变窄时，优先级较低的控件自动进入“标签栏操作”菜单，不依赖隐藏的横向滚动条。
下拉选择变成带选中标记的菜单选项，开关保留选中状态；窗格变宽后恢复显示。
无障碍标签和菜单始终标明插件身份。命令执行期间禁止重复触发，替换注册也不会绕过此限制。

内置组件可向 `useTabBarContribution` 传入第五个参数：
`{ placement, group, overflowActions }`。`overflowActions` 提供等价原生菜单操作；
没有等价菜单的自定义组件会保留在栏内。命令的正确性不得依赖控件所在位置。

这些可选字段属于 v1 契约，兼容旧宿主时仍应先检查接口发现结果。
已有控件保持默认靠后的位置和仅显示图标的按钮。

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
  placement: "trailing",
  group: "execution",
});
```

命令必须属于该插件的 manifest，且不能是编辑器或文件右键命令。按钮必须有命令；
文本不可执行命令；下拉选择需要命令、1–32 个值唯一的选项及有效的当前值。
调用命令时输入包含 `_tabBar: { itemId, tabId, tabKind, paneId, value }` 和
可空字符串 `_locale`。按钮的 `value` 为 `null`，下拉控件为这次请求选择的值。
上下文 ID 是不透明的提示信息，不授予权限；操作编辑器、文件或 SSH 时仍须调用
相应授权 API。更新下拉选择状态需要再次调用 `set`；命令失败时保留当前值。

省略 `when` 时只出现在插件自己的视图，包括停靠后的插件侧栏；`when: {}` 匹配
所有标签；`when: { tabKind: "editor" }` 匹配编辑器；
插件页面的公开类型是 `"plugin"`，与工作区内部存储类型分开投影。
`when: { tabId: "sidebar:output" }` 匹配输出面板。多个条件按 AND 组合，点击时再次
校验。`disabled: true` 阻止执行。

ID 只允许 ASCII 字母、数字和 `._-`，最多 128 字节；标题及选项文字/值最多
128 个字符且不允许控制字符。优先级 -1000 至 1000，数值较大者在前，同值按 ID
稳定排序。每个插件最多 8 个控件，宿主最多 128 个。控件属于当前运行代次，停止、
崩溃、卸载或撤销授权后移除。每次更新都会更换宿主签发的点击令牌，旧点击会被拒绝。
WebView 重载后通过宿主快照恢复，无需重新启动插件；内部变更事件为
`plugin://tab-bar-changed`。
该事件不是插件订阅接口，RPC 契约的 `events` 为空。命令执行仍检查当前批准状态、
运行代次和命令声明。控件不会授予其目标资源的访问权限。布局、溢出菜单的具体尺寸及
内部快照事件属于宿主实现细节，控件和命令数据契约不依赖这些内部状态。

支持的图标名：`activity`、`check`、`alert`、`info`、`sync`、`terminal`、`cloud`、
`code`、`plug`、`copy`、`clear`、`folder`、`file`、`wrap`、`follow`、`play`、`pause`、`filter`。
错误包括 `plugin.tabBar.invalidItem`、`plugin.tabBar.unknownCommand`、`plugin.tabBar.limit`、
`plugin.tabBar.expired`、`plugin.tabBar.invalidContext` 及常规授权错误。
非法控件、未知命令和配额错误通常使用 JSON-RPC `-32000`，授权失败使用 `-32001`。
移除时缺少 `id` 为 `plugin.api.missing:id`，类型错误为 `plugin.api.invalid:id`，
标识不合法为 `plugin.tabBar.invalidItem`。调用方应处理新增错误消息并忽略未知返回字段。
Schema 校验结构；选项值唯一性、当前值是否存在、命令归属及运行时配额另行检查。

[English](plugin-tab-bar.en-us.md)
