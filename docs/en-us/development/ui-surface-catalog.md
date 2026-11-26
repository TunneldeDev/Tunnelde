# UI/UX surface catalog

This catalog records design conventions and implementation locations for design and review. It is
not a claim that every surface has passed visual acceptance. Update the relevant row whenever a
surface changes: include its location, hierarchy, actions, narrow layout and states. Shared controls
are covered in [UI controls](ui-controls.md); ownership is covered in [panel layout](panel-layout.md).

## Shared rules

Keep the workbench → panel → section → content row hierarchy. Use existing theme tokens and
`components/ui` controls. Pages use the existing `.page` padding of 20px/24px and 14px gaps;
ordinary cards use 14px padding and compact sections generally use 12px. Terminal/editor content
and table rows retain their own density.

Place related creation actions together on the right of the section heading, followed by help,
refresh and overflow as applicable. Wrap a toolbar when space runs out; never cover the heading.
Keep creation discoverable outside empty states. Runtime actions belong to their group or row;
form save/cancel belongs at the bottom. Errors, consent and recovery information stay visible.
Pages scroll instead of shrinking cards until their contents overlap. Separate cards have complete
borders.

Important information must remain visible in the current flow: blocking errors and import conflicts
use error-colored borders/tints, an icon and a specific reason; generated passwords and security
consequences use a prominent warning area. Pair color with text. Do not hide these in tooltips,
newly appearing buttons or silent switches. Generated export passwords open a separate save-password
dialog with selectable text, explicit copy, cancel and “I saved the password — export”. Do not open
the file save flow before confirmation.

## Surface registry

| Feature and source location                                                                                                               | Hierarchy and presentation                                                                                                                                 | Actions, narrow layout and states                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workbench, docked/floating panels: `components/layout/WorkbenchPanel.tsx`, `PanelWorkspace.tsx`, `panelWorkspace.css`                     | One panel heading; shared content across tabs, splits and floating containers                                                                              | Actions on heading right; menu alternative to drag; preserve drafts, selection and focus; distinguish staging, loading and failure                                                                                                                   |
| Host tree: `components/layout/HostTree.tsx`, `HostRowFields.tsx`                                                                          | Search/filter above groups, hosts and secondary fields                                                                                                     | Create/import/group/view/overflow in panel heading; distinct selection and keyboard focus; fields wrap                                                                                                                                               |
| Host table: `components/layout/HostTable.tsx`, `hostTable.css`, `lib/hosts/columns.ts`                                                    | Shared column tracks for heading and rows; default name/address/user distribute available width, with readable minima 120/140/96px                         | Persist explicit widths; scroll the whole table below its minimum width; no pinned name covering other cells; vertically sticky heading; full-row hover, selection and focus; sort, resize and reorder                                               |
| Host export/import: `features/hosts/HostTransferDialogs.tsx`, `hostTransfer.css`                                                          | Export options → separate password confirmation → file save; import preview → conflict handling → apply; explanations and warnings have distinct hierarchy | Explicit generated-password confirmation; cancel preserves the same password/settings; direct and dependent conflicts use error border/tint, icon and reason; copies mode explains resolution; blocked import remains disabled with a visible reason |
| Host details: `features/hosts/HostPage.tsx`, `styles/app.css`                                                                             | Host heading → details card → forwarding → SOCKS5 → contributions → footer                                                                                 | 14px card gaps, no vertical card shrink; connect/files/monitor/processes and confirmed duplication at top; complete card borders                                                                                                                     |
| Port forwarding: `features/forwarding/ForwardingSection.tsx`, `forwarding.css`                                                            | Heading and host summary left; groups and rows have separate hierarchy; card on page, compact section when embedded                                        | Add forwarding/add group → help → refresh on heading right; bulk actions near rows; local forms/errors; toolbar wraps                                                                                                                                |
| SOCKS5: `features/forwarding/components/ProxySection.tsx`, `forwarding.css`                                                               | Same card level and border as forwarding; groups show listener, state and routes                                                                           | Add SOCKS5 group → help → refresh on heading right, small secondary button; creation tools hidden during edit; runtime/overflow on group row; textual empty state; toolbar wraps                                                                     |
| Connections/quality: `components/layout/ConnectionStatus.tsx`, `connectionStatus.css`, `features/connect/connectionQuality.css`           | Summary/status indicator then expanded details                                                                                                             | Disconnect follows connection; text accompanies state colors; distinguish connecting, disconnected and failed                                                                                                                                        |
| Terminal: `features/terminal/TerminalPage.tsx`, `NativeTerminalPage.tsx`                                                                  | Full available content area, monospace character grid and separate tools                                                                                   | Shared commands/shortcuts; resize without reconnect; loading/disconnect/retry distinct; same content and theme in satellite; after background WebView release, restore tools, screen and parser state using the existing session                     |
| File browser: `features/sftp/SftpPage.tsx`, `NativeFilePage.tsx`                                                                          | Path/tools above aligned file list; name primary, size/time secondary                                                                                      | Navigation/refresh/transfers near path; distinguish selection, loading, empty, failed and disconnected; allow scrolling                                                                                                                              |
| File editor: `features/editor/EditorPage.tsx`, `CodeEditorSurface.css`, `NativeEditorPage.tsx`                                            | Document toolbar, editing surface and status; native caret/selection/line numbers/monospace metrics                                                        | Save/encoding/format in toolbar; staging inert, committed view restores draft/location; retired reads cause no false failure, real failures keep diagnostics                                                                                         |
| Preview: `features/sftp/preview/previewPanel.css`, `NativePreviewContent.tsx`                                                             | Content first, type-specific local tools                                                                                                                   | Loading/unsupported/failed states; no duplicate resource owner on move; staging read-only                                                                                                                                                            |
| Tasks/transfers: `features/tasks/backgroundTasks.css`, `features/sftp/transferTasks.css`                                                  | Status summary → tasks → item progress/results                                                                                                             | Pause/resume/cancel follow item; textual running/attention state; hiding is separate from cancellation                                                                                                                                               |
| Output/diagnostics: `features/output/OutputPanel.tsx`, `output.css`, `components/ui/overlay/DiagnosticNotice.tsx`                         | Fixed tools/filters, scrolling records; summary → expandable details → copy                                                                                | Event ID, specific operation, safe reason, IPC action/panel kind/generation/duration; exclude request bodies, file content and credentials                                                                                                           |
| History: `features/history/HistoryPage.tsx`                                                                                               | Search, entries and secondary metadata                                                                                                                     | Local entry actions; distinct empty/loading/failed; shared filters/menus                                                                                                                                                                             |
| Monitor/processes: `features/monitor/MonitorPage.tsx`, `ProcessesPage.tsx`, `processes.css`                                               | Peer session panels for monitoring/processes, each reusing its existing content and aligned values                                                         | Refresh in heading; explicit confirmation for destructive process actions; disconnected is not zero data                                                                                                                                             |
| Settings: `features/settings/SettingsPage.tsx`, `fontSettings.css`, `settingsProfiles.css`, `storageSettings.css`                         | Section → field → explanation; inline help on roomy pages, tooltips in narrow dialogs                                                                      | Shared Field/SwitchRow/Select, associated validation; consistent action hierarchy for fonts/profiles/storage                                                                                                                                         |
| Known hosts: `features/settings/KnownHostsPage.tsx`, `KnownHostsList.tsx`                                                                 | Readable host identity/fingerprint grouping, selectable text                                                                                               | Refresh near heading; forget/delete clearly destructive; loading differs from empty                                                                                                                                                                  |
| Plugins/list/detail/config: `features/plugins/PluginsSection.tsx`, `PluginDetailPage.tsx`, `configuration/components/configuration.css`   | List → detail → configuration groups; explicit runtime/permission state                                                                                    | Install/start/stop/grants separate from config save; shared controls; diagnostics on failure; visible consent risks                                                                                                                                  |
| Plugin views/recovery: `features/plugins/PluginViewPage.tsx`, `recovery/components/recovery.css`, `components/layout/ProviderSurface.tsx` | Host panel hierarchy; recovery summary and details                                                                                                         | Distinct loading/unavailable/retired/recovery failure; moving does not restart plugin or discard draft                                                                                                                                               |
| Welcome/about: `features/welcome/WelcomePage.tsx`, `features/about/AboutPageView.tsx`                                                     | Brand and main entry first, muted secondary information                                                                                                    | Discoverable connect/import; About entries route to Settings → About; nonshrinking cards with 16px gaps                                                                                                                                              |
| Search/menus/dialogs/notices: `components/ui/`, `components/layout/HostSearch.tsx`                                                        | Shared controls, focus, disabled state, continuous corners and portal overlays                                                                             | Keyboard/touch/Escape ordering; help avoids scroll clipping; notifications expand/copy the same diagnostic                                                                                                                                           |

## Change and acceptance record

2026-11-25: aligned forwarding and SOCKS5 heading tools/borders, prevented host detail card shrink,
introduced default fluid host columns while preserving explicit widths, removed pinned-name occlusion,
and checked native ownership for editor reads racing a transfer commit. Generated export passwords
now use a separate save confirmation; direct and dependent import conflicts are highlighted. Future changes must consider
main/satellite, wide/narrow, light/dark and empty/populated/failed states. Record checks actually
performed; do not imply unperformed cross-platform acceptance.

## Usage habit management

Settings → Usage habits: `features/settings/components/HabitsSettingsView.tsx`. Use the settings section heading, save status, descriptive category checkbox cards and a footer action toolbar. Wrap actions at narrow widths and scroll tall content. Keep errors and reset consequences visible; explicitly review selected categories before resetting. Background tasks default to the bottom right, with persisted user geometry taking priority. See [User habits](user-habits.md) for category, upgrade retention and reset rules.

## 2026-11-27 acceptance fix conventions

Expanded host trees show hierarchy lines; floating tab-strip blank space supports dragging. Forwarding
and SOCKS5 groups use headings and indented bodies with hierarchy lines; narrow toolbars wrap. Host
duplication sits at the top right with confirmation; monitor/process entries sit beside files. Hidden
process pages suspend sampling, and session closure uses ordinary-consumer cleanup rules.

Settings support custom values and semantic units with matching frontend/backend ranges. Font previews
compare Latin/CJK grids on separate lines. Field/SwitchRow, plugin security switches, approved grants
and recovery disclosures use shared spacing and hierarchy lines. Conflict dialogs omit repeated prose
while retaining the actual conflict/actions. Plugin tags align with descriptions; details show known
permissions/contributions and view launchers sit beside top actions. History clicks insert commands;
double clicks execute them.

Transfers show rolling speed, average speed since the observation baseline and separate ETAs. Resume
retains the average baseline; a restart starts a new observation. Update settings offer independent
official history by channel with retry, even without an available update. Arbitrary historical-version
installation is not offered.

This round uses synthetic browser scenes with production components and automated tests. Physical
native-window dragging, real remote sampling, Windows/Linux and final installers require separate
acceptance. See [UI controls](ui-controls.md) for the shared conventions.

### Process pagination and height

The process page passes bounded flex height to the table viewport. Its footer provides first/previous/next/last navigation, direct page entry and 25/50/100/200 rows per page. Search and sorting reset to page one; size changes retain the page containing the current first row, and shrinking samples clamp the page. Controls wrap at narrow widths; very short windows allow container scrolling. Selection details and expanded metric help have bounded heights. Providers share the same native entries surface.

### Process actions and performance details

Process rows share the application context menu and Shift+F10: details, remote file location, stop and stop tree. Destructive actions require confirmation and identity revalidation. Run new task sits next to stop; its form retains command/directory input and displays errors or launch PID. Monitor page and panel share token-based detail cards, muted labels, monospace readings, wrapping device information and adaptive columns. Logical CPUs use a bounded scrolling grid, collapsed by default above 32 processors. Narrow/short panels scroll vertically. Missing values use em dashes with source limitations explained. Presentation changes reuse existing history and sampling.

Background tasks and Output share status button dimensions, typography, spacing, radii, hover, expanded and keyboard focus states. Running, paused, attention and aggregate progress enhance the same button without introducing a separate button style.

The retired monitoring inspector is no longer mounted, sampled or allocated width. Its status, settings and command entries are removed; performance and processes use their dedicated session pages/panels. Legacy preference fields and the Inspector extension slot remain compatible without restoring the old inspector. Compact Windows chrome reserves window controls in the rightmost workspace pane.
