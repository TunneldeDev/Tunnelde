# Syntax provider protocol fixture

This non-installable fixture exercises the host's real stdio handshake and bounded
`editor.readRange` protocol. It intentionally recognizes only `const` and decimal
numbers; it is not a supported tokenizer or a plugin example. It reuses the frozen
SDK in `../plugin-compat/core-sdk-v1` without copying or modifying that snapshot.

The complete installable example, packaging script and tokenizer tests live in
[Tunnelde-hub/examples/syntax-basic](https://github.com/TunneldeDev/Tunnelde-hub/tree/main/examples/syntax-basic).
