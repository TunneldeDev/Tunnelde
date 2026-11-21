# Temporary russh CLOSE acknowledgment patch

Base: crates.io `russh` **0.65.1**, crate SHA-256
`94be3d86c71b9ed220a675c405e35c7a02565a009bf8da2e9cc13a700320a5c5`.
Apache-2.0; the upstream license is included as `LICENSE.txt`.

The published crate removes a locally closed channel from the encrypted channel
map. Its established-channel guard then discards the peer's CLOSE acknowledgment,
leaving the channel receiver and reference alive until the entire SSH session
ends. Waiting for actual cleanup therefore deadlocks; enqueueing CLOSE or a
fixed timeout is not evidence of settlement.

Local changes are limited to `src/session.rs`, `src/client/encrypted.rs`,
`src/server/encrypted.rs` and the extra `Encrypted` test initializers in
`src/client/mod.rs` and `src/server/session.rs`:

- Retain confirmed locally closed channel IDs until one peer CLOSE or session end.
- Permit only CLOSE acknowledgments for those IDs. Unknown/unconfirmed IDs and
  all other message guards retain the existing strict checks.
- Never reuse an ID still awaiting acknowledgment.
- Discard queued output when the peer closes, so its reply cannot wait forever
  for a window update from a closed peer.
- Regression tests cover one-shot acknowledgments, unknown/unconfirmed IDs,
  blocked output and ID reuse. The application's real loopback SSH/SFTP tests
  additionally cover cancellation while waiting for a delayed CLOSE reply.

The rest of the registry crate is unchanged. `Cargo.toml` is the registry-normalized
manifest, with two explicit Clippy exceptions for upstream
`Result<_, ()>` APIs and map iteration style; `.cargo*`, the standalone lockfile and redundant `Cargo.toml.orig` are
omitted. Do not modify the global Cargo registry cache. Remove this patch when a
released upstream version passes both regression sets. Ordinary parent SSH
connections must remain usable after query cleanup.
