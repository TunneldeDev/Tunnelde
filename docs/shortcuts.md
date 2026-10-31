# Shortcuts

| Keys                           | Action                                                |
| ------------------------------ | ----------------------------------------------------- |
| `Ctrl+K`, `Ctrl+Shift+P`       | Command palette                                       |
| `Ctrl+N`                       | New host                                              |
| `Ctrl+,`                       | Settings                                              |
| `Ctrl+W`                       | Close the active tab (asks first for unsaved editors) |
| `Ctrl+Shift+W`                 | Close the focused pane when split                     |
| `Ctrl+\`                       | Split the active tab to the right                     |
| `Ctrl+Shift+\`                 | Split the active tab down                             |
| `Ctrl+Tab` / `Ctrl+Shift+Tab`  | Next / previous tab in the focused group              |
| `Ctrl+1` … `Ctrl+9`            | Jump to a tab in the focused group                    |
| `Ctrl+=` / `Ctrl+-` / `Ctrl+0` | Larger, smaller, default monospace size               |
| `Ctrl+X` / `Ctrl+C` / `Ctrl+V` | Cut, copy and paste files in the file panes           |
| `Ctrl+S`                       | Save the open remote file                             |

On macOS, the Command key also works for these actions. In a terminal,
`Ctrl+W` stays available to the shell; use `Cmd+W` on macOS or `Ctrl+Shift+W`
to close the terminal tab/group. Dialogs and input composition take precedence
over workspace shortcuts.

File panes:

| Keys                                | Action                                          |
| ----------------------------------- | ----------------------------------------------- |
| `↑` / `↓`                           | Move the selection                              |
| `Shift+↑` / `Shift+↓`               | Extend the selection                            |
| `Enter`                             | Open a folder, or edit/open the selected file   |
| `Backspace`, `Alt+↑`                | Go to the parent folder                         |
| `Alt+←` / `Alt+→`                   | Back / forward through folder history           |
| `F5`                                | Refresh the current folder                      |
| `F2`                                | Rename the selected entry in place              |
| `Ctrl+L`                            | Focus and select the current panel's path       |
| `Enter` / `Esc` in a filename input | Commit / cancel inline creation or rename       |
| `Delete`                            | Delete the selected entries                     |
| `Ctrl+A`                            | Select every entry                              |
| `Home` / `End`                      | Select the first / last entry                   |
| `Ctrl+N` / `Ctrl+Shift+N`           | Create a file / folder in the focused file pane |
| `Esc`                               | Clear the selection                             |

With the mouse, `Ctrl/Cmd+click` adds or removes one row and `Shift+click` selects a range. Delete,
transfer, cut, copy, paste and drag all act on the whole selection.

Window gestures:

- Middle-click a tab closes it.
- Double-click a tab pins or unpins it.
- Drag a tab onto another pane's strip to move it, or onto a window edge to
  create a pane on that side.
- Right-click a tab, host or file for its context menu.
- Settings → General switches between system and compact title bars. In compact
  mode, drag the grip or empty tab-strip space to move the window; double-click
  to maximize or restore. macOS retains its native window buttons.
- Drag a file or folder between the two file panes to copy it; dropping it in
  the same pane renames or moves it. Either pane can show this computer or any
  open session.
- Drag editor group dividers to resize, or focus a divider and use the arrow
  keys. Double-click or press Home to restore an equal split.
