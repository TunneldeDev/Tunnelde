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

New Beta milestones use **`vX.Y.Z-beta.1` through `vX.Y.Z-beta.9` only**.
The counter restarts at 1 for each new target stable version. Before a tenth
milestone would be needed, review and publish the stable release through the
promotion PR. At the cap, preparation stops before creating a commit, tag or
draft; it never promotes unfinished software automatically. Use Nightly for
intermediate testing. Same-source retries of beta.9 remain possible.

Allocation reads immutable tags, including historical formats and tags whose
release was retired, so numbers cannot silently be recycled. New publication
and recovery reject beta.10+, multipart Beta suffixes and compact betaNN names.
Historical metadata remains readable and comparable; the updater accepts stable
releases above already installed beta.10/11 builds. Nightly retains a permitted
Beta base plus `.d.<distance>.g<source>` without consuming Beta milestones.
See the version policy in [English](../../docs/versioning.en-us.md) /
[简体中文](../../docs/versioning.zh-cn.md).

The desktop updater has the same separation: `src-tauri/src/update/channels.rs` owns channel
eligibility; `update/feeds.rs` discovers GitHub/custom feeds; `update.rs` owns state, checks,
download/install and event delivery.

Run `node --test scripts/release/tests/*.test.mjs`, the release tests in
`tests/lib/release.test.ts`, and updater tests before changing this flow. See
[release operations](../../docs/releases.md) for triggers, credentials and recovery.
