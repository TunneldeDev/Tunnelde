# JSON Formatter

Format and minify JSON locally without losing numeric precision.

An independent official Tunnelde plugin. Requires Node.js 22 or later. No npm installation, network access, filesystem access or clipboard permission is required. Install the folder or its release ZIP in Tunnelde, then open the plugin view.

All fields and results remain local. Results are copied only when you click the host's Copy result button. Switching workspace tabs preserves unfinished input and the last result; closing the tab discards that draft.

## Commands

- `pretty`: Format JSON
- `minify`: Minify JSON

## Runtime protocol

JSON-RPC 2.0 over newline-delimited stdin/stdout. Supports initialize, view.render (main, optional locale), command.run (command, optional input), and shutdown. UI is declarative JSON rendered by the host; this plugin never sends HTML.

## License

GPL-3.0-only. Copyright (C) 2026 TunneldeDev.
