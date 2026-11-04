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
- Use Nightly snapshots for intermediate testing while stabilizing the release.
  They do not consume Beta milestones.
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

## Nightly and stable publication

Nightly uses a source-derived version, for example
`v0.28.1-beta.3.d.12.g0123456789ab`, or an `alpha.1.d...` base before the first
permitted Beta. Its commit distance can exceed 9. The milestone limit applies
to the number immediately after `beta.`, not to Nightly commit distances.

A build begins as a staging draft. It becomes public only after all four desktop
targets, signatures and `latest.json` pass verification. Beta and Nightly are
public prereleases; only the current stable publication becomes Latest.
Update selection compares semantic versions across all fetched pages rather
than relying on GitHub's display order or string comparison.

Historical releases normally remain immutable. Exceptional cleanup needs
explicit authorization, a local backup of release metadata and tag targets,
and a verified public replacement before removing superseded downloads.
Installed software keeps its embedded version after a remote tag is deleted.

See [release operations](releases.md) for workflow triggers and recovery.
[简体中文](versioning.zh-cn.md)
