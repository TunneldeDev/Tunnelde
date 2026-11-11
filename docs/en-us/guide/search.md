# Search and filter presets

Built-in list searches have a funnel button inside the right edge of the field.
Open it to see supported qualifiers and insert a preset. The query stays visible
and editable. An active qualifier highlights the funnel. **Clear filters, keep
search text** removes recognized qualifiers; × clears the entire query. Selecting
a preset returns focus to the input.

Combine words with `@key:value`. Commas within one qualifier mean OR; repeated
qualifiers mean AND. Use `-@key:value` to exclude values. Quote values containing
spaces or commas, such as `@tag:"production east"`. Every qualifier requires the `@` prefix. Bare `key:value` terms, unknown
qualifiers and unfinished prefixes remain literal text. The funnel shows fields relevant to each list.

| Search                  | Examples                                                               |
| ----------------------- | ---------------------------------------------------------------------- |
| Hosts and remote picker | `@tag:production,staging @user:deploy -@is:favorite`                   |
| Plugin marketplace      | `@tag:tools @name:format @author:publisher`                            |
| Current folder          | `@ext:json,md @size:>10MiB @modified:>=2026-11-01`                     |
| Hidden files            | `@is:hidden`, including when hidden files are normally off             |
| Command history         | `@command:git @date:2026-11-09`                                        |
| Trusted hosts           | `@host:example @port:22 @algorithm:ssh-ed25519`                        |
| Processes               | `@user:root @cpu:>10 @memory:>100MB`                                   |
| Output                  | `@level:WARN,ERROR @domain:plugins.network @plugin:identifier`         |
| Settings                | `@is:modified @section:appearance @id:monoFontSize`                    |
| Chat history            | `@name:deployment @is:active @date:>=2026-11-01`                       |
| Keyboard shortcuts      | `@is:conflict @plugins:identifier`, retaining shortcut-specific syntax |

Numbers accept `>`, `>=`, `<`, `<=` and `=`. Byte sizes support decimal units
(`KB`, `MB`, `GB`, `TB`) and binary units (`KiB`, `MiB`, `GiB`, `TiB`). CPU uses
the percentage displayed in the process list. Dates use local calendar days in
`YYYY-MM-DD` format. Existing scope controls and qualifiers both apply.

## Quick access

Press F1. Use `>` for commands, `%` for literal contents, `@ ` (an at sign and a space) for saved hosts, or
no prefix for files/open tabs. The funnel adapts to the selected mode:

- Commands: `@category:Plugins`, `@plugin:identifier`, `@id:app.restart`.
- Files: `@name:report @ext:json,md -@path:vendor`.
- Contents: `% Foo  Bar @ext:ts @path:src` preserves the two spaces in `Foo  Bar`.
  Content phrases must have at least two characters.

File qualifiers apply during local or remote traversal, before result limits and
content reads. Unsaved open documents replace the corresponding saved content.
Search remains bounded by entry, result, file-size, depth and time limits; the
partial-results notice still applies. Recursive quick access skips hidden/build
directories and links. Current-folder filtering supports `@is:hidden`.
