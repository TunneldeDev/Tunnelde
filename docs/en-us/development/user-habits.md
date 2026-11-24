# User habit persistence and management

Habits are user data. Restarts, upgrades and replacing application bundles must preserve them; never clear them based on package versions.
Settings → Usage habits is a separate searchable section. Each category explains its scope, reset effects and timing.
Important consequences use visible text and warning surfaces. Review selected categories before explicitly confirming a reset; preserve selection and errors on failure.

| Category              | Storage and restoration                                                                                              | Reset scope                                                                                                                     |
| --------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Native windows        | window-state in the app configuration directory; size, position, maximization, fullscreen; native display correction | Default size and centered position for main and current independent windows, then persist                                       |
| Panels                | Private `user-habits-v1` settings-table record with a synchronous browser cache                                      | Presentation, floating geometry, open/pinned state, sidebar selection and private workspace floating geometry                   |
| Typography            | Existing app Settings; imported fonts stored separately                                                              | Font selections and UI/monospace sizes; retain imported files                                                                   |
| Appearance and layout | Existing app Settings                                                                                                | Theme, colors, custom CSS, density, motion, sidebar/right-panel widths and host list style                                      |
| File views            | Private habits; per-location columns, widths, sorting, grouping, layout and split ratios                             | Clear matching cache; reopen views to apply                                                                                     |
| Open paths and panels | Existing tabs and frozen workspace v1 layout; remote paths restore offline without connecting SSH                    | Clear the next-start snapshot, preserve current editors, pause snapshot saving for this session to prevent immediate recreation |

Background tasks default to the bottom right above the status bar when no user geometry exists. Saved geometry takes priority and clamps to the available area.
Workspace floating geometry is a private extension and does not change the frozen public workspace v1 contract.

Startup reads the native durable record before rehydrating already-created panel stores and restoring the workspace. Migrate legacy localStorage only when the native record is absent; an empty record is an intentional valid reset.
A failed native read must never overwrite existing data with defaults. Show the error in the management page.
The main document serializes writes of the latest snapshot. Independent documents notify it through same-origin storage events and do not receive generic settings/database authority.
Native validation bounds key namespaces, entry count, individual values and total size. Never log habit bodies, directory paths, document contents or credentials.
Detached Settings uses the closed `habitsReset` / `habitsDetails` owner effect and the same main service. Its private projection contains status and counts only.

Acceptance covers legacy migration, native restoration after an update, rehydrating initialized panel stores, ordered slow writes, retaining unreadable durable data, category resets preserving hosts/credentials/drafts, and matching behavior in main/detached Settings.
See the [UI surface catalog](ui-surface-catalog.md) for visual conventions.

Each category has an independent disclosure that loads concrete records on demand, labels saved/current/default values, and allows selecting long paths. Expanding never selects a reset. Failed reads show an error and refresh action. Reset invalidates old details. Window geometry uses physical pixels. Workspace details expose only known layout/path fields, never editor content.
