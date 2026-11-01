# Plugin marketplace

Official plugin and theme sources, the generated registry, deterministic packages, validation
and release workflows have moved to the independent
[TunneldeDev/tunnelde-hub](https://github.com/TunneldeDev/tunnelde-hub) repository.

The desktop app consumes the hub's `registry.json`. This repository contains the plugin host,
API protocol and [developer guide](../docs/plugins.md), plus the small
[`examples/plugins/hello`](../examples/plugins/hello) SDK example.

`marketplace/index.json` is retained as a compatibility snapshot for older desktop versions.
New package submissions and catalogue updates belong in the hub.
