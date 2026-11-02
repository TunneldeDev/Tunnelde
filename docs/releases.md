# Release operations

## Normal workflow

1. Open a feature PR targeting protected `main`. Its Conventional Commit title becomes the squash commit.
2. Pass Web, Rust, Repository hygiene, the three Native helpers checks and PR policy; update the branch
   with `main` and resolve review threads. Squash merge.
3. **Release PR** creates or updates one `release-please--branches--main` branch and PR. Its generated
   changelog and every application/native version are reviewed together. The script groups changes
   since the previous version tag into bilingual categories, with highlights, expandable details,
   PR/commit links and contributors. It writes only to the release branch. No installers build yet.
4. Merge the release PR. Automation creates a draft for the exact merge SHA, creates its immutable
   version tag, and explicitly invokes **Release**. The four desktop builds share the draft.
5. Wait for **Verify completed draft** to succeed, inspect its notes/assets, then click **Publish release**
   in GitHub Releases. Select the release as latest. `latest.json` becomes publicly available with it.

A complete build never automatically publishes the release. Until publication, the previous public
version remains available to the desktop updater. A failed build leaves its draft available for recovery.
Native helpers and compiler timings are Actions artifacts, not public desktop downloads.

Only one unfinished draft is allowed. It blocks another release PR from merging, but does not block
normal fixes. After publishing, the next push to `main` (or a manual **Release PR** dispatch) resumes
the cumulative release PR. Publishing/deleting a release refreshes the PR-policy status automatically.

## Version and changelog policy

`feat` increases minor; `fix`, `perf`, `build` and `revert` increase patch. Hidden maintenance types
(`docs`, `test`, `ci`, `chore`, `refactor`, `style`) do not produce a release by themselves. A breaking
change marked with `!` or a `BREAKING CHANGE:` footer increases minor before 1.0 and major after 1.0.
The initial automated baseline is the existing `v0.26.0` tag; it is never changed.

Release Please updates `package.json`, Tauri config, both Cargo manifests/lockfiles and
`.release-please-manifest.json` and `CITATION.cff`. CI rejects mismatches. This repository has one
root release; the empty release package name keeps component prefixes out of its branch/tag parsing.
`scripts/release/release-notes.mjs` reads the
exact main SHA and its previous version tag, groups Conventional Commits, combines duplicate titles
and collects PR authors and GitHub coauthors. Tests/style-only changes and release commits are omitted.
Build/CI changes remain visible. This process is deterministic and needs no AI service or extra token.

`updateReleasePr` writes the resulting `CHANGELOG.md` only to `release-please--branches--main`, using
a non-forced update based on the expected head. Historical version entries are preserved byte for byte.
Ordinary development PRs need no changelog edits, and automation never commits directly to `main`.
Optional existing Unreleased notes become highlights. The pending section is regenerated as main
advances, so review the result in the release PR before merging.

Keep normal PR bodies to a few sentences: the title becomes the squash subject and the body becomes
its message. Release PR bodies contain a short version summary and a link to the changelog; their
delimited version heading is required by Release Please. When that PR is merged, the draft receives
the complete notes from the exact release commit's changelog rather than the short PR body.

For an explicit version such as 1.0.0, set `release-as` in the root package entry of
`release-please-config.json` through a reviewed PR. Inspect the resulting release PR and remove the
override in a subsequent PR once that version is cut. Never rewrite an existing tag. The local
`pnpm release:prepare` utility remains available for reviewed exceptional version preparation; it does
not push or publish, and all resulting changes must still use a PR.

## Automation credentials

The default setup uses the short-lived repository `GITHUB_TOKEN`; no personal access token or App
secret is required. Enable **Settings → Actions → General → Workflow permissions → Allow GitHub
Actions to create and approve pull requests**. Keep the default token permissions read-only: each
workflow declares its required permissions. The automation creates PRs and never approves reviews.

GitHub normally prevents the token's own writes from starting another workflow. After preparing the
release branch, automation explicitly dispatches `CI` on that branch, which attaches checks to its
actual head SHA. The trusted metadata workflow sets the required `PR policy` commit status.

For a dedicated GitHub App, install it on this repository with Contents and Pull requests read/write
permissions and set repository variable `RELEASE_APP_ID` plus secret `RELEASE_APP_PRIVATE_KEY`.
The App creates the release PR and draft; the normal workflow token performs check dispatch and
metadata updates. Do not grant the App Ruleset bypass, repository administration or organization-wide
access. Never commit a private key. Missing/invalid configured App credentials fail visibly rather
than silently falling back.

## Main Ruleset

`.github/main-ruleset.json` is the reviewed configuration for **Protect main**, targeting
`refs/heads/main`, with no bypass actors. It blocks deletion and force pushes, requires linear history,
PRs, resolved conversations, all seven named CI/policy checks and a branch up to date with `main`.
Required checks are bound to the GitHub Actions integration. Additional-member approvals are set to
zero so the maintainer can merge their own PR after checks pass. Repository merge settings allow only
Squash, use the PR title for the commit subject, and delete merged branches.

Apply rule updates through the GitHub Rulesets API or **Settings → Rules → Rulesets** after the matching
workflows and checks are available. Ruleset changes do not automatically follow edits to the JSON file.
No CI workflow has permission to change these protection rules.

## Recovery and withdrawal

For an interrupted draft, dispatch **Release** from `main` with its original `existing_tag`. It checks
that the tag matches all versions, belongs to `main` history, and corresponds to exactly one existing
draft with the same source SHA. It rebuilds the original tagged source with the current workflow,
replaces assets and validates the updater manifest, leaving the result as a draft. Select
`build_helpers` only if optional helper Actions artifacts also need rebuilding.

Re-running **Release PR** does not increment versions again or duplicate an existing draft. If a draft
was created but its tag step failed, first resolve that failure and create only the missing tag at the
recorded merge SHA; never move a tag. Then use **Release** recovery.

To abandon a draft, explicitly delete it in Releases; do not reuse its version or tag. The next release
uses the version already recorded on `main` as its baseline and increments again. Public releases are
never overwritten by recovery. The marketplace repository has its own independent release process.
