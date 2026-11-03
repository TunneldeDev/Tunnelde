# Release tooling

GitHub Actions orchestrates these modules. Each directory owns one responsibility:

| Directory     | Responsibility                                                                  |
| ------------- | ------------------------------------------------------------------------------- |
| `github/`     | Immutable source reads, refs, ancestry and Git trees                            |
| `metadata/`   | Version formats, channel identity, manifest transforms and changelog summaries  |
| `planning/`   | Promotion PR planning, reviewed source validation and PR policy                 |
| `publishing/` | Beta/Nightly snapshots, stable tag preparation, drafts and verified publication |
| `tests/`      | Release logic, real Git history and CI recovery regression tests                |

Root CLI entry points prepare local releases, check versions, extract notes, build updater
manifests and verify assets. `automation.mjs` and `release-notes.mjs` forward existing imports;
workflow jobs import their responsible module directly. Package generation is separate from
publication: all platforms must finish and pass verification before the release becomes public.

The desktop updater has the same separation: `src-tauri/src/update/channels.rs` owns channel
eligibility; `update/feeds.rs` discovers GitHub/custom feeds; `update.rs` owns state, checks,
download/install and event delivery.

Run `node --test scripts/release/tests/*.test.mjs`, the release tests in
`tests/lib/release.test.ts`, and updater tests before changing this flow. See
[release operations](../../docs/releases.md) for triggers, credentials and recovery.
