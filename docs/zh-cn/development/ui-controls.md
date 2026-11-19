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
