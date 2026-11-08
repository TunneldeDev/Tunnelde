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
  50-pixel steps. Double-click a separator to fit its column to the header and
  currently displayed contents, including text hidden by ellipsis.
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

Changing the interface language keeps an open preview and its existing file
connection. Audio/video position and player settings, and PDF page and zoom,
remain in place while the controls and supported error messages are translated.

## Searching open work

Press F1 and type `> ` to find commands, or `% ` to search file contents. The scope
selector offers directories from file panels and open editors, including an
editor's parent directory when no file panel is open. You can also choose a local
folder. Content search uses open editor text in place of that file's saved
contents, so unsaved edits are searchable without saving them. Choosing a matching
buffer result returns to that editor and line. Local Windows drive and UNC paths
are compared across slash direction and letter case; remote paths retain case
and literal backslashes.

## Moving file panels

To move one side of the file manager into its own group, drag its grip to a
workspace edge, another group's body, or a position in its tab strip. An edge
creates a split; the center or tab strip adds a tab to that group. Splitting
keeps the panel's previous width or height where the available space allows.
Dragging outside a drop target or pressing Esc leaves the original panel intact.

## Copying files

Copies from the file browser and plugin copy commands use the background task
engine. Open **Background tasks** to see progress, apply a speed limit or cancel.
Existing destination files remain intact while a new file is staged; publication
happens after the data and file close have completed. Cancelling cleans unpublished
staging files and retains the source and any files already committed. A directory
copy commits individual files; it is not a transaction for the entire directory.

Within the same SSH session, optimized copies use the server's supported
`copy-data` extension without relaying file data through this computer. Other
copies use the normal transfer pipeline.

## Copy-based directory moves on Windows

Local directory moves that need copying use the background task engine. The
source inventory, destination directory identities and verified file copies are
recorded separately. All files are copied and checked before source removal
begins, and the recovery journal is flushed before that boundary.

After an interruption, Resume checks the recorded identities and full file
contents. Once source removal has begun, it continues verification and cleanup
without restarting the copy phase. Changed or replaced files are retained for
review. Newly added source entries are retained; a source directory is removed
only when it is empty. This is a sequence of verified file moves, rather than an
atomic transaction for the whole directory.

Copy-based moves detect Windows named data streams on source files and
directories and retain those sources, since the transfer pipeline does not copy
these streams. Use a native filesystem move or a stream-preserving tool for them.

This recovery applies to Windows local paths. Remote directory moves that would
require copying and deleting remain restricted; ordinary moves within one remote
host still use server-side rename.

## Failed remote moves

Cut/paste within one remote host uses a server-side rename, avoiding a round trip
through this computer. A server may reject a rename between different mount points.
SFTP status 4 (`Failure`) is a general failure and does not identify its cause;
destination conflicts and server restrictions can also produce it.

Failed moves report both paths and preserve the server's available explanation.
Use **Open original log** in the error notification for the structured details.
The failed item remains in the cut selection; successful items in the same batch
are removed from it. Refresh both locations before retrying after a lost connection,
because a missing reply cannot prove whether the server completed the operation.
An unspecified failure does not trigger an automatic copy-and-delete retry.
