# 公共面板布局

`src/lib/layout/types.ts` 定义可序列化的 `PanelLayoutNode` 树。叶子记录面板 ID，
拆分节点记录 ID、方向、比例和两个子节点。比例为 0 到 1 的小数，工作区现有的
序列化结构保持兼容。

`src/components/ui/layout/` 下的 `PanelLayout` 是受控渲染组件。调用方传入布局、
`renderPane(paneId)`、`onResize(splitId, ratio)` 和已翻译的分隔条无障碍标签。
组件不依赖工作区、存储、文件管理或插件模块。布局有效性、持久化、停靠、标签操作和
隐藏面板状态由调用方负责。保持节点 ID 和渲染回调稳定，可以在调整比例时保留挂载内容。

`SplitPanels` 为布局树和功能双栏提供同一套分隔行为，支持横向／纵向、flex／grid、
可配置边界、分隔条尺寸、键盘与复位操作。拖动时每个动画帧最多直接预览一次 DOM 几何，
松开后才通过 `onRatioChange` 提交。指针取消、Escape、失焦或卸载会丢弃预览，
恢复最新受控比例，包括拖动期间通过键盘提交的比例。指针移动不会保存偏好或重渲染子面板。

工作区 `PaneLayout` 只负责适配状态仓库。文件管理 `FileSplitView` 使用同一个公共
分隔组件，保留原有本地偏好适配和 20–80% 边界。存储键改变时重新挂载偏好适配层，
防止不同文件视图互相覆盖比例。工作区仍使用 15–85% 边界。

应用与插件面板继续通过现有工作区停靠宿主接入，共享位置、尺寸、显隐与标签操作。
此次重构不会把实验性的插件工作区 API 自动提升为稳定接口。

行为检查见 `tests/components/PanelLayout.test.tsx`、
`tests/components/PaneLayout.test.tsx`、`tests/features/FileSplitView.test.tsx`
及工作区／侧栏停靠测试。新增消费者应复用公共控件，避免重新实现指针监听或持久化。
