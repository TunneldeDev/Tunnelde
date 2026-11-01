# Official utility plugins

Each directory is a separate installable plugin requiring Node.js 22 or later. They have no npm dependencies and request no host permissions.

| Package          | Tools                                                                                                 |
| ---------------- | ----------------------------------------------------------------------------------------------------- |
| `json-formatter` | Pretty print, minify, JSON errors with line/column/position; preserves original numbers and key order |
| `timestamp`      | Unix seconds/milliseconds, date conversion with UTC/local time and explicit offsets, current time     |
| `uuid`           | Cryptographically random UUID v4, batches of 1–100                                                    |

Run `node --test plugins/tests/official.test.mjs` to check the algorithms, real subprocess protocol, archive contents, and checksums. Run `node scripts/plugins/package.mjs` to produce deterministic ZIP archives, `index.json`, and `SHA256SUMS` under `artifacts/plugins`. An optional first argument changes the output directory.

The archive root contains `tunnelde-plugin.json`, `index.mjs`, and `README.md`. You can also install the source directory directly. Release archives are separate from the desktop installer.

## Declarative tool views

Older heading, text, key/value, and table views remain supported. A tool can return a form block from `view.render`:

```json
{
  "title": "Example tool",
  "blocks": [
    {
      "type": "form",
      "id": "example",
      "fields": [
        { "id": "source", "type": "textarea", "label": "Input", "value": "" },
        {
          "id": "mode",
          "type": "select",
          "label": "Mode",
          "value": "basic",
          "options": [{ "value": "basic", "label": "Basic" }]
        }
      ],
      "actions": [{ "id": "run", "label": "Run", "command": "run" }]
    }
  ]
}
```

The host renders accessible application controls, never plugin HTML. Supported field types are `text`, `textarea`, and `select`. Identifiers are unique per form, start with a letter or digit, and contain at most 128 letters, digits, dots, underscores, colons, or hyphens. Forms support up to 20 fields and 12 actions; select fields support 100 options. Duplicate identifiers, inherited object property names, and malformed fields are ignored.

`view.render` receives `{ "view": "main", "locale": "zh-CN" }` (locale is optional). A button invokes `command.run` with `{ "command": "run", "input": { "source": "…", "mode": "basic", "_locale": "zh-CN" } }`. The first button is also the form's default submit action. Textareas retain Enter for newlines. Commands must be declared in the manifest.

Return `{ "text": "Result", "title": "Optional title", "error": false }`. Plain text or legacy JSON results are also rendered as text. The host preserves whitespace, renders an error state for `error: true`, and provides explicit Copy result and Clear buttons. Plugins cannot read or write the clipboard through this schema. Input is capped at 256 KiB of JSON; displayed results are capped at 1 MiB of UTF-8. Oversized data reports an error instead of silently truncating results.

Drafts and results survive tab switches, workspace splits, refresh, and language changes while the form identity remains stable. Closing the tab discards them. A pending command disables its form's action buttons; late results from a closed view are ignored.

## Precision and dates

JSON formatting validates syntax without serializing parsed JavaScript numbers back into the result, so large integer literals, exponents, duplicate keys, and string whitespace survive. Pretty printing rejects extreme nesting or output size; minifying remains available.

Timestamps support millisecond precision, including fractional seconds such as `1.001`, negative values, zero, and the JavaScript date range. Dates use `YYYY-MM-DDTHH:mm[:ss[.SSS]]` with optional `Z` or `±HH:mm`. Invalid calendar dates and local times skipped by daylight saving are rejected. Explicit offsets override the selected zone. Ambiguous local times during a daylight saving overlap follow the runtime's earlier occurrence; specify an offset to choose an occurrence explicitly.
