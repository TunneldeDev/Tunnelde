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

## 综合工作台面板

`WorkbenchPanel` 是内置面板和插件侧栏的默认综合容器，内部组合公共标题栏、位置菜单、
展示状态和小窗几何控制。业务只提供一份正文和可选的 `PanelHeader` 操作，宿主将操作
移入统一标题栏，避免重复标题。只有特殊用途才直接组合底层基础组件；任务、连接详情、
输出、文件预览和插件侧栏不再分别维护小窗与面板外壳。

`SidebarContents` 为已访问面板保留唯一 React 所有者，`SidebarMount` 在侧栏、工作区和
小窗之间移动同一个 DOM 容器。同文档切换保留搜索、选择、展开和滚动；关闭只隐藏展示，
不停止 SSH 会话、任务或插件运行时。工作区关闭保留隐藏槽位。小窗使用通用状态并迁移旧
任务几何数据；进程内检查点可恢复已打开的小窗，但冷启动不自动弹出临时小窗。插件贡献
被移除时清理展示；停止运行时保留已安装视图的启动占位，运行时资源仍按作用域释放。

此机制只适用于同文档，不等于跨 WebView 所有权交接；没有明确交接协议前，不得声称
原生独立窗体能够保留 DOM 或所有临时状态。

### 实验性插件控制

通过 `extensions.describe().panelPresentations` 发现支持的展示方式与方法。
`workspace.panels.list` 返回 `{revision,windowId,panels}`，仅包含标识、可用性、位置、
可见性、固定状态和几何数据，不包含业务正文、草稿、密码或任意 store。

- `workspace.panels.observe({revision?})`：revision 不同时立即返回，否则等待变化或最多
  十秒。revision 是进程内不透明值，不提供持久重放；取消会释放监听。
- `workspace.panels.setPresentation({panelId,presentation})`：将现有面板移到 `sidebar`、
  `workspace` 或 `floating`。文件预览必须已存在，插件面板必须仍在贡献列表中。
- `workspace.panels.close({panelId})`：隐藏面板，不停止业务资源。

读取和观察需要 `workspace.read`，变更需要 `workspace.write`。正常请求授权、取消与
回复前的运行时代次检查保持不变。`workspace://panels-changed` 仅是包含 `{windowId}` 的
UI 失效通知；RPC 插件应使用 `observe` 并重新读取，不可从事件交付推断当前状态。
冻结的 `workspace.snapshot` v1 不变。

## 分隔线交点

`SplitGeometryScope` 不增加布局包裹节点，可连接由 React portal 保留的不同正文。
应用在工作台外统一接入；独立使用 `SplitPanels` 时会自动提供局部作用域。不同 DOM
根分别处理，因此小窗不会调整无关工作区边界。几何注册使用实例级 ID；语义 split ID
只需在同一所有者／批量回调内唯一，不要求不同布局根之间唯一。所有者或拓扑变化会
取消旧手势。

宿主按真实分隔线段寻找 T 型或十字交点。交点可同时调整两轴，相接的同轴线段共同
移动，无关线段不参与。各参与者使用自己的容器尺寸和上下限，按最严格的公共位移
限制保持对齐。预览复用帧级指针控制，不重渲染正文或逐次持久化；Escape、指针取消、
失焦和卸载恢复最新受控比例。方向键调整单轴，Shift 精细调整，Home 或双击重置。

为 `PanelLayout` 提供 `onResizeMany` 以原子更新一个所有者的布局。工作台通过
`workspace.resizeSplits` 一次发布两轴变更。独立控件保留 `onRatioChange`；跨不同
业务所有者的手势按所有者各提交一次，不声称独立持久化适配器属于同一数据库事务。
插件可通过实验性的 `workspace.resizeSplits({ratios:{splitId:ratio,...}})` 操作，
需要 `workspace.write`；一至三十二个已知 ID 和有限的 0.1–0.9 比例全部通过校验后
才执行一次变更，既有工作区尺寸限制仍会钳制比例。冻结的 workspace v1 不变。
