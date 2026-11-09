# Historical plugin fixture

`v0.28.0/hello` is an unchanged copy of `examples/plugins/hello` from the
`v0.28.0` tag (commit `324ba1950a14311260fd6d47d4b3516520990560`). Its files
are pinned by SHA-256 in the host tests. Add a new fixture for a later release
instead of updating this snapshot.

The opt-in host transport test loads the historical manifest and runs the
plugin through initialization, command, view, error and shutdown exchanges.
It does not cover the full application, permission approval, storage, or host
API calls. CI explicitly supplies its Node executable; the test never discovers
or uses a user's Node runtime automatically.

`editor-v1.json` freezes the editor buffer RPC contract. CI executes the actual
frontend bridge to generate response samples, runs them through the Rust frontend
reply/error encoder, validates their schemas and replays them through the frozen
SDK. This complements desktop acceptance; mock authorization in the bridge test
alone does not prove native permission enforcement or cross-platform UI behavior.

`tab-bar-v1.json` freezes registration, removal and advisory command input for
tab-bar contributions. The host emits samples from the actual runtime registry
and command serializer. CI validates them against the frozen schemas and replays
registration/removal responses through the historical SDK. Duplicate option values,
selection membership, quotas and authorization remain runtime checks. Neither the
frozen item contract nor the command context exposes internal layout state.

`logging-v1.json` freezes the `log` input, null result and JSON-RPC error envelope.
Actual wire-adapter samples include legacy levels, structured options, byte/depth/node
limits, nullable identifiers and ignored unknown fields. They pass through schema checks
and the frozen SDK; legacy cases call its unchanged `host.log` helper. Writer tests also
check severity filtering, trusted identity and structured redaction. No fixture promises
durable delivery, free-text secret detection or a stable on-disk record layout.
