# Editor commands and formatters

An installed plugin can contribute commands that act directly on the open editor.
Press **Ctrl+Shift+F** (**Cmd+Shift+F** on macOS), use **Format document** in the
editor toolbar, or find a command with **F1**. Outside the editor, Ctrl+Shift+F
continues to search workspace contents. Settings → Keyboard Shortcuts lists host
and installed plugin commands, including plugin defaults; users can change or
disable each binding. Profiles preserve those changes.

When multiple formatters match, choose a provider. Running a formatter follows
the existing plugin permission and runtime consent steps. A declined prompt never
sends document text to the plugin. Changes stay in the unsaved buffer and can be
undone in one step. Save explicitly when ready. Results from an older document
version, a closed/reopened editor, or a revoked runtime are discarded.

## Contributions (Tunnelde 0.29.0-beta.2 and later)

```json
{
  "permissions": ["editor.read", "editor.write"],
  "engines": { "tunnelde": ">=0.29.0-beta.2" },
  "commands": [
    {
      "id": "format",
      "title": "Format document",
      "editor": { "extensions": ["json"], "format": true }
    },
    {
      "id": "compact",
      "title": "Compact document",
      "editor": { "extensions": ["json"] },
      "keybindings": ["Mod+Alt+M"],
      "macKeybindings": ["Meta+Alt+M"]
    }
  ]
}
```

Extensions omit the leading dot, match case-insensitively, and may contain compound
suffixes. Only `format: true` commands participate in Format document. Other editor
commands are available through F1 and their bindings. A command receives
`{source, document: {tabId, documentId, version, path, name}, indent, _locale}` and
returns `{text: string}` or `{error: true, text: string}`. `indent` is the editor's
tab size as a string. Return text without modifying disk files. The host applies
one undoable edit only if the original identity and version still match.

Input/output document text is limited to 128 KiB UTF-8. The serialized command input
must also fit the existing 256 KiB RPC bound, including JSON escaping. Invalid or
oversized responses leave the buffer unchanged. No filesystem, SSH, clipboard or
network permission is needed for a pure text transformation.

`keybindings` and optional `macKeybindings` accept up to four combinations using
`Mod`, `Ctrl`, `Meta`, `Alt`, `Shift`, and a letter, number, function key or named key
such as `Comma`. `Mod` maps to Ctrl on Windows/Linux and Command on macOS. Actual
AltGraph input and IME composition never trigger commands. Editor commands take
precedence over matching workbench shortcuts while the editor has focus.

## Host API

- `editor.active` (`editor.read`): the ready active document snapshot, or `null`.
  The snapshot contains `tabId`, `documentId`, `version`, `path`, `name`, `content`
  and `dirty`. It excludes session details, saved credentials and baseline data.
- `editor.replace` (`editor.write`): `{tabId, documentId, version, text}`.
  Returns `{tabId, documentId, version, dirty}` after an undoable replacement.
  Stale, closed, loading and disconnected documents are rejected. An unchanged
  replacement preserves the version. Successful changes increment it.

Both methods use the existing authorized frontend bridge and runtime-generation
checks. The host exposes open buffers only, never arbitrary files. They retain
API version 1 and do not change older plugin calls. See the independent marketplace
SDK for the generated method catalogue and TypeScript interfaces.

[中文](editor-plugins.zh-cn.md) · [Plugin development](plugins.md)
