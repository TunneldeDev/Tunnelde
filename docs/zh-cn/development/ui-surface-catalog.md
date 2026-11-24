# 功能界面与 UI/UX 风格台账

本页记录各功能位置的设计约定和实现入口，供设计、开发和评审对齐；不代表所有位置已完成视觉验收。
新增或修改界面时同步更新对应行，包含入口、层级、操作位置、窄宽度行为和状态；不要仅记录截图。
公共控件与主题规则见 [公共 UI 控件](ui-controls.md)，窗口归属见 [面板布局](panel-layout.md)。

## 全局规则

沿用工作台、面板、板块、内容行四层结构。颜色、字体、圆角和控件尺寸使用现有主题 token 与
`components/ui` 封装。页面间距沿用 `.page` 的 20px/24px 内边距和 14px 间距；普通卡片内边距
14px，紧凑面板内部通常 12px。不要把页面卡片的留白直接套在终端、编辑器或表格行上。

相关新建操作置于标题工具栏右侧，随后是帮助、刷新与更多菜单；右侧工具栏保持自身尺寸，宽度不足
时整组换行，禁止覆盖标题。正文空态不承载唯一的新建入口。运行操作跟随对应分组／行，表单的
保存与取消在底部。危险操作、授权和恢复信息直接可见。页面内容超出高度时滚动，不压缩卡片使其
子内容跨卡片溢出；每张独立卡片保留完整边框。

重点信息必须在当前流程中直接可见：阻断错误、导入冲突使用红色边框／浅底、警告图标和具体原因；
待用户保存的密码与安全后果使用醒目的警告区域。颜色必须配合文字，不能只藏在 tooltip、
新增按钮或静默开关里。自动生成导出密码后切换到独立保存确认对话框，提供可选择的密码、
显式复制、取消和“已保存密码，继续导出”；确认前不打开文件保存流程。

## 位置台账

| 功能位置／实现入口                                                                                                                 | 布局与视觉层级                                                                      | 操作、响应式与状态约定                                                                                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 工作台外壳、侧栏、停靠／浮动面板：`components/layout/WorkbenchPanel.tsx`、`PanelWorkspace.tsx`、`panelWorkspace.css`               | 一个面板标题；内容复用原实现；标签、分栏和浮动框遵循工作台主题                      | 标题右侧面板操作；拖拽有菜单替代；移动保留草稿、选择和焦点；冻结、加载、失败明确区分                                                                           |
| 主机列表树：`components/layout/HostTree.tsx`、`HostRowFields.tsx`                                                                  | 顶部搜索与筛选；组→主机→附加字段；名称为主要信息，地址及插件字段为次要信息          | 新建／导入／分组／视图／更多在面板标题；选中与键盘焦点可区分；字段允许换行                                                                                     |
| 主机表格：`components/layout/HostTable.tsx`、`hostTable.css`、`lib/hosts/columns.ts`                                               | 表头与行共用列轨道；名称／地址／用户默认按可用宽度分配；最小可读宽度 120／140／96px | 手动列宽优先并持久保存；不足时整表横向滚动；名称不固定遮挡其他列；表头纵向固定；悬停、选中与焦点覆盖整行；列支持排序、调整宽度及移动                           |
| 主机导出／导入：`features/hosts/HostTransferDialogs.tsx`、`hostTransfer.css`                                                       | 导出设置→独立密码保存确认→文件保存；导入预览→冲突处理→提交；普通说明与警告分层      | 自动密码需显式保存确认；取消返回设置且保留同一密码；冲突及受冲突跳板影响的条目红色边框／浅底＋图标＋原因；选择副本模式后说明处理结果；阻断时禁用导入并显示原因 |
| 主机详情：`features/hosts/HostPage.tsx`、`styles/app.css`                                                                          | 顶部名称与连接操作；详细信息卡片→端口转发→SOCKS5→扩展区域→页脚                      | 卡片间距14px，禁止纵向压缩；连接在页首，复制在页脚；转发卡片各自保持完整边框                                                                                   |
| 端口转发：`features/forwarding/ForwardingSection.tsx`、`forwarding.css`                                                            | 左侧标题与主机摘要；规则分组与内容行分层；页面为卡片，嵌入面板为紧凑板块            | 右侧添加转发／新建转发组→帮助→刷新；批量启动靠近规则；编辑与错误在本板块；窄空间允许工具栏换行                                                                 |
| SOCKS5：`features/forwarding/components/ProxySection.tsx`、`forwarding.css`                                                        | 与端口转发同级、同卡片边框和标题层级；组内显示监听地址、运行状态与路由              | 标题右侧新建SOCKS5组→帮助→刷新，使用 secondary 小按钮；编辑时收起创建工具；运行／停止和更多位于分组行；空态为正文文字；窄空间工具组换行                        |
| 连接／质量：`components/layout/ConnectionStatus.tsx`、`connectionStatus.css`、`features/connect/connectionQuality.css`             | 连接摘要与状态点；详情再展开；质量信息使用次要文字                                  | 断开跟随连接；状态不能仅靠颜色；连接中、断线和失败有独立呈现                                                                                                   |
| 终端：`features/terminal/TerminalPage.tsx`、`NativeTerminalPage.tsx`                                                               | 内容铺满可用区域，终端使用等宽字体；工具条不侵占字符网格                            | 菜单与快捷键复用；调整大小不重连；区分连接中、断线和重试；独立窗口沿用内容与主题                                                                               |
| 文件浏览：`features/sftp/SftpPage.tsx`、`NativeFilePage.tsx`                                                                       | 路径／工具条→文件列表；列对齐；名称为主，大小／时间为辅                             | 导航、刷新与传输靠近路径；选择、加载、空目录、错误和断线分开；窄空间允许列表滚动                                                                               |
| 文件编辑：`features/editor/EditorPage.tsx`、`CodeEditorSurface.css`、`NativeEditorPage.tsx`                                        | 文档工具条、编辑面、状态信息分层；原生光标、选区、行号与等宽字体                    | 保存、编码、格式化在文档工具条；迁移暂存时不可编辑，提交后恢复原草稿／位置；迟到读取不产生虚假失败；真实失败保留诊断                                           |
| 文件预览：`features/sftp/preview/previewPanel.css`、`NativePreviewContent.tsx`                                                     | 预览内容优先；类型特定工具留在预览区域                                              | 显示加载、不可预览及失败；切换位置不重复持有资源；暂存只读                                                                                                     |
| 后台任务与传输：`features/tasks/backgroundTasks.css`、`features/sftp/transferTasks.css`                                            | 状态栏摘要→任务列表→单项进度和结果                                                  | 暂停、继续、取消跟随任务；运行与需要处理有文字状态；隐藏面板不等于取消                                                                                         |
| 输出与诊断：`features/output/OutputPanel.tsx`、`output.css`、`components/ui/overlay/DiagnosticNotice.tsx`                          | 工具条与筛选固定，日志内容独立滚动；错误摘要→展开详情→复制诊断                      | 保留事件ID、具体操作、安全错误原因、IPC子动作／面板类型／代次／耗时；不把请求正文、文件内容或凭据放入日志                                                      |
| 历史：`features/history/HistoryPage.tsx`                                                                                           | 搜索、历史条目与次要元数据分层                                                      | 操作跟随条目；保留空态、加载和错误；复用共享菜单与筛选                                                                                                         |
| 监控／进程：`features/monitor/MonitorPage.tsx`、`processes.css`                                                                    | 主机／资源概览与进程表分层；数值对齐                                                | 刷新位于标题工具栏；危险进程操作有明确确认；断线不伪装为零数据                                                                                                 |
| 设置：`features/settings/SettingsPage.tsx`、`fontSettings.css`、`settingsProfiles.css`、`storageSettings.css`                      | 分组标题→字段→说明；宽页面内联帮助，窄对话框使用提示                                | 使用统一 Field／SwitchRow／Select；解释与验证关联字段；字体、profile、存储子页复用相同尺寸与操作层级                                                           |
| 已知主机：`features/settings/KnownHostsPage.tsx`、`KnownHostsList.tsx`                                                             | 指纹与主机身份清晰分组；身份信息可选择复制                                          | 刷新靠近标题；删除／忘记是明确的危险操作；空态和加载分开                                                                                                       |
| 插件列表、详情与配置：`features/plugins/PluginsSection.tsx`、`PluginDetailPage.tsx`、`configuration/components/configuration.css`  | 列表→插件详情→配置分组；运行与权限状态显式展示                                      | 安装／启停／授权与配置保存分离；复用共享按钮、菜单和表单；失败带诊断入口；不隐藏授权风险说明                                                                   |
| 插件视图与恢复：`features/plugins/PluginViewPage.tsx`、`recovery/components/recovery.css`、`components/layout/ProviderSurface.tsx` | 提供者复用宿主面板层级；恢复项有状态摘要和详情                                      | 加载、不可用、退役、恢复失败分开；不因切换呈现重启插件或丢弃草稿                                                                                               |
| 欢迎／关于：`features/welcome/WelcomePage.tsx`、`features/about/AboutPage.tsx`                                                     | 品牌与主要入口优先；次要说明为弱化文字                                              | 新建连接、导入等入口可发现；沿用统一按钮和主题，不额外创建独立控件风格                                                                                         |
| 搜索、菜单、对话框及通知：`components/ui/`、`components/layout/HostSearch.tsx`                                                     | 统一控件、焦点、禁用态、连续圆角与 Portal 浮层                                      | Escape顺序、键盘和触屏可用；帮助不被滚动区域裁剪；通知可展开并复制同一诊断                                                                                     |

## 修改与验收记录

2026-11-25：统一主机详情两种转发卡片的标题工具栏与边框，取消详情页子卡片收缩；
主机表格采用默认自适应列，保留显式列宽，移除名称列遮挡；编辑窗口迁移读取复核原生归属。
同时将自动生成导出密码改为独立保存确认对话框，突出导入冲突及受影响的依赖条目。
这些位置的后续改动应同时核对主窗口／独立窗口、宽／窄面板、明／暗主题、空态／有内容／失败，
并记录实际完成的检查，不把未进行的跨平台验收写成已完成。

## 使用习惯管理

设置 → 使用习惯：`features/settings/components/HabitsSettingsView.tsx`。采用设置分区标题、保存状态、带说明的分类复选卡片、底部操作工具栏。窄宽度整组换行，超高内容滚动；失败与重置后果直接可见；重置先显式确认所选类别。后台任务默认右下角，用户位置持久优先；所有类别、更新保留及重置规则见[使用习惯](user-habits.md)。
