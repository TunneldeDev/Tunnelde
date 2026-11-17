# Basic syntax highlighting example

This is a small, dependency-free example provider for Tunnelde's editor syntax
highlighting. It is intentionally a **lightweight tokenizer**, not a complete
parser or language server. It recognizes comments, quoted strings, numbers,
a conservative keyword list, function-like identifiers and other identifiers
in common JavaScript/TypeScript, JSON, CSS, HTML, Python, Rust, Go, Java and C
family source files. It does not build an AST, resolve types, parse templates,
or guarantee exact language semantics.

## Install and use

1. Copy this folder or install it as a plugin from the Plugins page.
2. Start the plugin and approve its declared `editor.read` permission.
3. Open a supported file in the editor. Highlighting is applied automatically
   only while the plugin is running and authorized.

Tunnelde never starts this plugin or prompts for permission just to highlight a
file. Stopping or updating the plugin, revoking its permission, or switching to
another document immediately clears the rendered tokens. Errors, timeouts,
invalid token ranges and files above the 128 KiB highlighting cap fall back to
plain editor text.

## Protocol

The command receives:

```json
{
  "source": "const value = 1;",
  "document": {
    "tabId": "editor:...",
    "documentId": "...",
    "version": 0,
    "path": "/project/file.ts",
    "name": "file.ts"
  },
  "extensions": ["ts"],
  "_locale": "en-US"
}
```

Large documents use `mode: "window"` with `source: null` and a bounded
`range`. The provider reads that exact document/version through
`editor.readRange` in 16K pages and returns window-relative tokens. Window
highlighting is approximate: a comment or template that begins before the
window may not be fully understood.

It returns semantic, half-open UTF-16 ranges only:

```json
{
  "tokens": [
    { "start": 0, "end": 5, "type": "keyword" },
    { "start": 14, "end": 15, "type": "number" }
  ]
}
```

Allowed token types are `keyword`, `string`, `number`, `comment`, `type`,
`function`, `property`, `operator`, `punctuation`, `variable`, `constant` and
`invalid`. The host supplies colors; plugins cannot return HTML, CSS, classes or
other styling. At most 16,384 tokens and 128 KiB of serialized token data are
accepted per result.

`sdk.mjs` is included and is the frozen core SDK fixture, pinned by SHA-256 in
the packaging script. From this directory run `npm run package` (or
`node scripts/package.mjs <directory>`) to produce an installable folder whose
files can be copied/installed through Tunnelde's local plugin installer. The
command does not install into the application or start a plugin.
