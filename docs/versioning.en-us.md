# Version and release policy

`dev` is the default contribution branch. `main` contains reviewed stable
releases. A generated promotion PR preserves the original development commits;
merge that PR with **Create a merge commit** after required checks pass.

## Public Beta milestones

- Use `vX.Y.Z-beta.1` through `vX.Y.Z-beta.9` only. **Never publish beta.10 or higher.**
- Each target stable version has its own sequence. After `v0.28.0`, a new
  `0.28.1` cycle starts at `v0.28.1-beta.1` (or `v0.29.0-beta.1` for a minor cycle).
- Review and publish the stable version before a tenth milestone would be
  needed. At the limit, automation stops before creating a snapshot, tag or
  draft. It does not promote incomplete work automatically.
- Use `pnpm build:local` for intermediate development testing.
  Local builds do not consume Beta milestones.
- Failed builds reserve their tag. Retry the same immutable source/tag instead
  of allocating another number. A beta.9 retry is allowed.
- Do not delete tags to reset a counter, pad numeric identifiers with zeroes,
  use compact betaNN names, or rename old binaries under a different version.

The same restrictions apply to manual tags, draft recovery and final publication.
Historical versions remain readable for comparison and update discovery, even
when their format is no longer permitted for new publication. Stable `0.28.0`
is newer than installed `0.28.0-beta.9`, `.10` and `.11`; both the Stable and
Beta update channels can offer it. Switching the channel does not downgrade an
already installed newer version.

## Local testing and stable publication

Nightly publication is disabled. There is no scheduled or manually dispatched
Nightly workflow, and publication rejects creating, resuming or publishing Nightly
releases. Use local development builds instead. Historical Nightly versions remain
readable and comparable for compatibility with existing installations and metadata.

A build begins as a staging draft. It becomes public only after all four desktop
targets, signatures and `latest.json` pass verification. Beta versions are
public prereleases; only the current stable publication becomes Latest.
Update selection compares semantic versions across all fetched pages rather
than relying on GitHub's display order or string comparison.

Installers, updater packages and signatures include the version in their filenames,
for example `Tunnelde_0.29.0-beta.4_aarch64.app.tar.gz` and its `.sig` file.
The updater manifest keeps the fixed name `latest.json`; its URLs point to the
actual versioned assets. GitHub generates the Source code download entries.

Historical releases normally remain immutable. Exceptional cleanup or reissue
needs explicit authorization and a local backup of release metadata and tag
history. Validate the replacement source before deleting superseded downloads;
build fresh packages from that source and verify them before publication.
Never rename old binaries as the replacement. Reusing a version is a maintenance
exception, not a way to reset Beta allocation. Existing installations at the same
or a higher version need manual installation: update checks do not offer an
equal version or an automatic downgrade. Deleting a remote tag does not change
the version embedded in installed software.

See [release operations](releases.en-us.md) for workflow triggers and recovery.
[简体中文](versioning.zh-cn.md)

In-app updates offer only Stable and Public beta. Developer Nightly snapshots
are excluded; legacy Nightly preferences migrate to Stable.
