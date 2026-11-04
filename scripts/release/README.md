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

GitHub's public Releases page and REST listing may put same-day `beta.9` before
`beta.11`. Never infer a channel's newest version from list position, publication
date or string comparison. Version selection uses numeric SemVer ordering across
all pages; a release is eligible only after publication with matching channel
metadata and `latest.json`.

New Beta milestones use `vX.Y.Z-beta.b01` through `vX.Y.Z-beta.b99`. The
alphanumeric identifier permits a fixed two-digit sequence under SemVer and
keeps lexical order aligned with numeric order. Pure numeric `beta.01` would be
invalid SemVer. The `beta.` prefix preserves older clients' channel recognition.
Legacy `beta.N` and `beta.N.M` tags remain valid and reserve their original
number; after `beta.11`, the next preparation is `beta.b12`. A new target
version resets to `b01`. Preparation refuses to allocate milestone 100 before
creating a commit or tag, requiring a reviewed promotion or a new target.
Nightly builds retain the latest Beta base plus `.d.<distance>.g<source>` and
do not consume Beta numbers. Existing published tags and package bytes never
change as part of this migration.

The desktop updater has the same separation: `src-tauri/src/update/channels.rs` owns channel
eligibility; `update/feeds.rs` discovers GitHub/custom feeds; `update.rs` owns state, checks,
download/install and event delivery.

Run `node --test scripts/release/tests/*.test.mjs`, the release tests in
`tests/lib/release.test.ts`, and updater tests before changing this flow. See
[release operations](../../docs/releases.md) for triggers, credentials and recovery.
