# File browser

[简体中文](files.zh-cn.md)

Open **Files** from the activity bar or a host's file action. Each file panel has its
own source selector, path, selection and view preferences. You can open multiple
panels for the same source and drag their tabs into separate workbench groups.

## Columns and view preferences

In **View options**, choose **Details view** or **Column view**. Details view supports:

- Showing or hiding Type, Size and Modified columns. Name remains visible.
- Dragging a column header to reorder columns.
- Dragging the separator at a header's edge to resize that column. A focused
  separator also accepts Left/Right in 10-pixel steps, or Shift+Left/Right in
  50-pixel steps.
- Clicking a header to sort, with another click reversing its direction.

Filtering, grouping, hidden files and folders-first ordering are independent for
each panel. Column order and widths are saved with its view preferences.
Resizing previews changes while dragging and saves them on release. Esc or switching
away from the window cancels an unfinished drag. The separator between two file
panels follows the same behavior; double-click it to restore equal widths.
**Reset panel view** restores the default columns, order and widths, clears the
filter and grouping, and restores sorting and hidden-file defaults from Settings.

Column view expands folders along their hierarchy. Click a folder to open its next
column. Right opens a selected folder; Left returns to the parent and selects the
folder you just left. Clicking or typing in an earlier column makes it the current
operation target.

## Paths and keyboard navigation

Click a breadcrumb to navigate, or its adjacent arrow to list child folders.
Click the empty area on the right of the path bar, or press Ctrl+L (Cmd+L on macOS),
to edit the path. Enter opens the path; Esc cancels editing. Both return keyboard
focus to that panel's file list.

Type to select a name, including committed input from an input method. Consecutive
characters form a prefix; repeated characters can match names such as `yy.exe`.
Arrow keys, Home and End move the selection; Shift extends a range and Ctrl/Cmd
click toggles individual entries. Refresh preserves surviving selected entries
and their range anchor. Navigating to a different directory starts a new selection.
Changes in another panel or a plugin also refresh the list without discarding a
path draft.

New files, folders and renamed entries use inline fields. Enter commits; Esc
cancels and returns focus to the list. The newly created or renamed entry is
selected and scrolled into view. A failed operation keeps the draft and reports
the error. Find platform-specific and customizable bindings in
[Keyboard shortcuts](shortcuts.en-us.md).

Files open inside Tunnelde. Space and the preview action open Quick Look;
compatible plugins can add preview formats. Local entries offer explicit native
application/file-manager actions in their context menu. Transfer behavior,
recovery limits and preview size limits are documented in
[Network routes, transfers and SSHFS](network-storage.en-us.md).
