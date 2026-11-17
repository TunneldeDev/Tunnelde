# Editor syntax highlighting

[简体中文](../../../zh-cn/development/plugins/editor-syntax.md) · [Editor commands](editor-plugins.md)

Plugin syntax highlighting is experimental. It colors code inside an open small
editor document; it does not decorate file-list rows and it never modifies the
document. The built-in textarea remains the only editing and accessibility
surface. The host renders validated semantic tokens in an `aria-hidden`,
pointer-events-none overlay. Without a usable result, the normal plain text is
shown.

## Manifest contribution

A command declares `editor.syntax: true` and the extensions it handles. A
syntax-only command requires `editor.read`, not `editor.write`:

```json
{
  "permissions": ["editor.read"],
  "commands": [
    {
      "id": "highlight",
      "title": "Highlight source",
      "editor": { "extensions": ["ts", "tsx"], "syntax": true }
    }
  ]
}
```

The permission rules remain conservative:

| Editor declaration                     | Required permissions          |
| -------------------------------------- | ----------------------------- |
| `syntax: true`, no `format`            | `editor.read`                 |
| `format: true`                         | `editor.read`, `editor.write` |
| legacy editor command, no `syntax`     | `editor.read`, `editor.write` |
| both `syntax: true` and `format: true` | `editor.read`, `editor.write` |

The host chooses the first matching syntax-only provider. It does **not**
automatically start the plugin or open a consent prompt for highlighting.
Highlighting is invoked only when that exact provider is already running and
its existing `editor.read` grant is present. If there is no such provider, the
editor stays plain; the user can start or approve the plugin explicitly.

## Command contract

Input:

```json
{
  "source": "const answer = 42;",
  "document": {
    "tabId": "editor:...",
    "documentId": "...",
    "version": 3,
    "path": "/project/main.ts",
    "name": "main.ts"
  },
  "extensions": ["ts"],
  "_locale": "en-US"
}
```

Output:

```json
{
  "tokens": [
    { "start": 0, "end": 5, "type": "keyword" },
    { "start": 15, "end": 17, "type": "number" }
  ]
}
```

Offsets are half-open UTF-16 code-unit ranges in the exact input `source`.
They must be in bounds, cannot split a surrogate pair, and must be ascending and
non-overlapping. Results allow at most 16,384 tokens and 128 KiB serialized.
Token types are limited to `keyword`, `string`, `number`, `comment`, `type`,
`function`, `property`, `operator`, `punctuation`, `variable`, `constant` and
`invalid`. The host maps these types to its own theme colors. Plugin-provided
HTML, CSS, class names or arbitrary properties are rejected.

Source and request limits are 128 KiB UTF-8 and 256 KiB serialized. Larger
documents remain plain text and do not send a highlighting request. Highlighting
is debounced after edits; requests are cancelled or discarded when the document
identity/version, provider package, runtime, permission grant or editor tab
changes. A provider error or timeout also falls back to plain text.

## Rendering and editing guarantees

The native textarea retains selection, caret, undo/redo, IME composition, word
wrap and browser scrolling. The overlay matches the textarea font, font size,
line height, tab width, padding, wrap mode and viewport, and synchronizes both
scroll axes. It is hidden during IME composition so composition text cannot be
transparent or duplicated. Forced-colors mode also shows the native text.

The included [`syntax-basic` example](../../../../examples/plugins/syntax-basic/README.md)
is a deliberately lightweight tokenizer for common source files, not a complete
language parser or language server. Production providers should implement the
same bounded semantic-token contract with a real parser if they need exact
language semantics.
