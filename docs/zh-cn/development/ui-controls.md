# 公共 UI 控件

交互控件优先使用 `src/components/ui/` 中的封装，不在业务页面重复实现控件和
尺寸规则。已有 `Button`、`IconButton`、`Input`、`Textarea`、`Select`、
`SearchField`、`Switch`、`Field`、菜单和对话框等基础组件。组合这些基础组件，
而不是为所有语义 HTML 元素额外套一层。

`layout/Disclosure` 统一可展开区域的标题和状态摘要，保留原生键盘操作。界面
提供者设置默认折叠，筛选设置时自动展开；摘要显示自定义及不可用的选择数量。
展开区域不会启动插件或保存选择。

`Switch` 位于 `form/Switch.tsx`（`form/Field.tsx` 保留兼容导出），支持原生按钮
属性、`ref`、`className` 和 `style`；受控状态、角色及按钮类型由组件统一管理。
带解释文字的设置使用 `SwitchRow`，统一关联标题和可选说明，并在窄空间中让文字
换行、保持开关尺寸。单独使用的开关同样不会被 flex 布局压缩。

可以在局部作用域通过 CSS 属性自定义：

- `--td-switch-width`、`--td-switch-height`（默认 32px、18px；宽度不得小于
  高度，高度需大于 6px），滑块尺寸与移动距离自动跟随。
- `--td-switch-track`、`--td-switch-border`、`--td-switch-active`。
- `--td-switch-thumb`、`--td-switch-thumb-active`。
- `--td-control-row-gap`（默认 16px）。

颜色默认沿用现有主题变量。通用布局约束放在公共组件，业务排列放在业务样式中，
保留原生键盘、焦点、禁用和标签行为。主机文件导入、导出分别使用 `FileInput`、
`FileOutput`，下载箭头留给下载操作。

## 紧凑空间的说明与密码

`overlay/Tooltip` 用于非交互帮助文字，提供延迟悬停、聚焦和触屏点击展示，支持
Escape 优先关闭、移入提示继续阅读、视口边界定位及卸载清理。内容通过 Portal
避免被滚动容器裁剪。使用渲染回调提供的描述 ID 关联触发控件。
`form/HelpHint` 将其包装成文字右侧的圆圈问号，不放在 `<label>` 内，避免点击帮助
误切换开关。不要只依赖原生 `title`，键盘与触屏也必须能阅读帮助。

`Field`、`SwitchRow` 按 `HelpPresentationProvider` 的上下文展示说明。默认整页为
`inline`；`Dialog` 内默认为 `tooltip`，紧凑面板也应设置这个上下文。可用
`hintPresentation` 局部覆盖。Dialog 的 `help` 放在标题右侧，不单独占正文行。
只收起静态说明；错误、运行结果、安全警告、授权说明与生成密码的保存确认必须直接
可见，需要时明确使用 `inline`。不要依据字符串或 CSS 类自动隐藏文字。

`PasswordInput` 统一密码框右侧的显示／隐藏小眼睛，支持受控显示状态和可选复制动作。
复制由调用方明确提供，不默认读取剪贴板；切换显示不改密码、不提交表单。主机导出
的全选／取消全选放在底部取消按钮左侧，筛选时仅改变可见主机的选择。
