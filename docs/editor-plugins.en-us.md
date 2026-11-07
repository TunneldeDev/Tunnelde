# Editor commands and formatters

An installed plugin can contribute commands and shortcuts for the open editor.
Use **Format document** in the editor toolbar or find an installed plugin command
with **F1**. A plugin can assign a default shortcut; check **Settings → Keyboard
Shortcuts** for the actual binding. No formatting shortcut is registered when no
plugin contributes one. Settings profiles preserve customized bindings.

When an installed or updated plugin introduces a shortcut conflict, choose which
binding to keep, keep the conflict, or open the filtered shortcut settings. Retained
conflicts are highlighted in red. In the editor, each matching command is invoked
in sequence, including applicable workbench commands; a plugin command only applies
to its declared file extensions. Check the bindings before retaining a conflict:
for example, `Ctrl+Shift+F` already opens workspace content search.

When multiple formatters match, choose a provider. Running a formatter follows
the existing plugin permission and runtime consent steps. A declined prompt never
sends document text to the plugin. Changes stay in the unsaved buffer and can be
undone in one step. Save explicitly when ready. Results from an older document
version, a closed/reopened editor, or a revoked runtime are discarded.

## Local document saves

Local documents use the same draft retention and conflict review as remote
documents. Saving writes a private sibling staging file, flushes and reads it
back, checks the original identity and contents again, then replaces it atomically
on the same volume. A write, verification or publication failure leaves the
original intact. Deleted files are not recreated; symbolic links retain their
resolved target behavior. Saving requires write access to the original file and
permission to create a private staging directory in its parent.

Windows saves preserve owner/group, DACL, alternate data streams and supported
file attributes. Unix saves preserve owner/group, mode and extended attributes;
macOS also copies native ACLs and resource forks. If required metadata cannot be
preserved, saving fails before replacement. These guarantees depend on filesystem
support; filesystem-specific attributes outside these contracts are not promised.

Interrupted cleanup is journaled without document contents and appears in
**Background tasks**, including its local path and retry action. Application
startup retries known staging cleanup. Unknown or replaced staging objects are
retained for review instead of being recursively deleted.

Conflict detection is optimistic: another process can replace a pathname after
the last check. Windows holds the original against ordinary in-place writes
during staging; Unix writers do not have to honor application locks. Atomic saves
create a new file object, so hard links and already-open readers keep the old
object. Flushing staging data does not guarantee directory durability after
power loss.

`files.local.writeText` uses the same transaction for existing UTF-8 text files,
with an optional `baseline` holding the last text read. Older callers can omit it:
the host snapshots the file at the start and checks it again before publication.
Without a baseline, changes made before the call cannot be detected. Both the
original and replacement must be text and at most 512 KiB; the serialized request
must also fit the existing 256 KiB RPC limit. `fs.write` is sufficient; the internal
comparison does not require granting `fs.read`.

For AI/MCP tool writes, the approved path, canonical grant roots and original
content hash are checked again inside the transaction. Runtime authorization,
client revocation and request cancellation are checked before staging and just
before publication. Cancellation or revocation after that final gate cannot roll
back a replacement already in progress. Pending cleanup uses the same background
task and startup recovery mechanism as editor saves.

## Remote document saves

Saving an existing remote text document checks its last loaded contents. If another
program changed the file, the editor retains your draft and offers **Compare changes**.
The comparison shows the current disk version and your draft. Reloading the disk
version is undoable; replacing it checks the reviewed disk contents again. A stale
comparison cannot apply after the document changes or reconnects.

Remote saves use a private `.tunnelde-save-<uuid>` sibling directory. The host writes
and reads back the complete staged text, waits for write and close acknowledgements,
preserves the SFTP owner/group/mode fields, checks the original again, and publishes
with `posix-rename@openssh.com`. The original is never truncated as a fallback.
The server must support that extension and allow creating a sibling directory;
otherwise saving fails while retaining the original and the editor draft. Deleted
files are not recreated. Editing a symbolic link updates its resolved target and
keeps the link itself.

Only cleanup metadata, not document contents, is journaled locally. Cleanup failures
appear in **Background tasks**, with a retry action. Reconnecting to the same saved
host and address retries cleanup, including after restarting the application.
Cleanup verifies the private directory and ownership marker and never recursively
deletes unrecognized contents. Changed or unverifiable staging directories are
preserved for review; the task shows their location.

This is optimistic conflict detection: SFTP v3 provides no conditional rename, so a
different program can still write between the last comparison and publication.
Atomic replacement creates a new inode; existing hard links continue to reference
the old inode. SFTP v3 does not expose a complete ACL/xattr contract, so preservation
of those extended attributes is not guaranteed. `fsync@openssh.com` is used when
advertised; file and directory durability after server power loss is not guaranteed.

`files.sftp.writeText` accepts optional `baseline` text. Pass the last contents read
to reject external edits. Older plugins that omit it remain supported: the host
reads a baseline at the start and checks it again before publication. Omitting it
cannot detect changes made before the save call. Inspect `api.describe` to determine
whether a host supports the parameter.

## Contributions (Tunnelde 0.29.0-beta.2 and later)

```json
{
  "permissions": ["editor.read", "editor.write"],
  "engines": { "tunnelde": ">=0.29.0-beta.2" },
  "commands": [
    {
      "id": "format",
      "title": "Format document",
      "keybindings": ["Mod+Shift+F"],
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
AltGraph input and IME composition never trigger commands. Matching editor and workbench commands can both run when their binding is retained.

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

[中文](editor-plugins.zh-cn.md) · [Plugin development](plugins.en-us.md)
