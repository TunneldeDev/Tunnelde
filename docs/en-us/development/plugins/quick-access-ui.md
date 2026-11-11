# Quick-access result providers

[简体中文](../../../zh-cn/development/plugins/quick-access-ui.md) · [Interface providers](ui-providers.md)

Declare a component view with `provider: "quickAccess"`, a trusted frontend and
`ui.trusted`, `hosts.read`, `sessions.read`, `fs.read`, `sftp.read`, `workspace.read`
and `editor.read`. Users explicitly select it in settings. Metadata searches never
activate contributed plugins or implicitly discover the user's Node installation.

`props.quickAccess.snapshot` is an immutable experimental DTO describing mode,
query, root, selection, total, search status and errors. Modes include `>` commands,
`%` content, `@ ` hosts and files. Field filters require `@` prefixes. Described
paths and sessions do not authorize resource access.

Use `read({ revision, offset? })` to page collected results: at most 128 entries and
65,536 serialized UTF-16 units per `items` array. Keys are opaque and valid within
one revision. `truncated` marks clipped text. The native list displays 100 entries
per page without silently dropping later commands, hosts or tabs. File traversal
and unsaved-content merging retain independent limits, reported by `limited`,
`skipped` and host chrome. Pagination does not mean unlimited filesystem searches.

`setQuery` accepts up to 4096 UTF-16 units; `select` selects a current entry.
`invoke` additionally requires `workspace.write` and delegates to native dispatch,
including native confirmation and the target plugin's consent. This grants
workbench interaction, not a bypass around target plugin approval. Query changes,
close/reopen, target edits and connection changes retire old actions. Package and
contribution identity are checked again after activation consent. Opening a result
closes the palette; repeated calls cannot dispatch the same opening twice.

Optional `Entries` mounts at most once, composing native icons, shortcuts,
selection and existing entry DOM. Omitting it does not stop searches. The host
retains input, filter presets, root selection, pagination, errors, Escape and
recovery. Crashes, duplicate mounts, revocation and deactivation fall back to native
presentation. Trusted frontends share the host context and are not a sandbox.

Public contracts live under `contracts/search/quickAccess/{entry,provider}`;
private adapters under `extensions/search/quickAccess/{projection,context,provider}`.
The feature separates `data/`, `runtime/` and `components/`; the former component
entry only re-exports compatibility names. This remains experimental. Plugin
dependency graphs and complete activation orchestration remain separate work.
