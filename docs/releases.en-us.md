# Release operations

[简体中文](releases.zh-cn.md)

## Branches and normal workflow

`dev` is the default branch and contribution target. `main` is stable. Both require PRs,
resolved review conversations and the seven CI/policy checks. Dev requires linear history. Squash merge
ordinary work into `dev`, or rebase merge to preserve meaningful individual commits; only the
generated release promotion targets `main`, where **Create a merge commit** is the only allowed method.

1. A `dev` push runs CI and **Development**. Automation resolves the actual `dev` and `main`
   refs and collects changes after the last promoted dev commit recorded on main in
   `.github/release-source.json`. Dev does not need to contain main's release commits.
2. One generated `release/dev-to-main` PR is created or refreshed. Its tree is dev's content
   plus synchronized versions, the source marker, and the new changelog section. The final
   preparation commit has current main and dev as its two parents. This retains every original
   dev commit and SHA while remaining up to date with strict branch protection. The branch can be
   rebuilt with a forced update; dev, main and existing tags are never force updated.
3. Dev pushes do not publish installers. Use **Prepare Beta → Run workflow** to select the
   current dev snapshot, synchronize its six desktop version files and changelog in an isolated commit,
   and create the next immutable `vX.Y.Z-beta.N` tag. Beta is an explicit testing milestone.
4. **Publish version** listens to `push.tags: ["v*"]`. Stable tags publish stable releases; Beta
   tags publish prereleases. Direct tag pushes must already have matching version manifests and
   release notes and belong to the correct branch history. Lightweight and annotated tags work.
   Tags created by `GITHUB_TOKEN` do not trigger push workflows, so automation explicitly dispatches
   this same publisher with the exact tag. Repeating an already public tag skips rebuilding it.
5. Review the version and changelog in the release PR, then **Create a merge commit** into main.
   **Stable release** verifies the reviewed parents and tree and tags the exact merged commit;
   **Publish version** builds Windows, Linux, Apple Silicon and Intel macOS packages.
6. Every build first shares one staging draft. Only after all desktop artifacts, signatures and
   `latest.json` pass verification does it become public. Titles are the complete version tag,
   e.g. `v0.28.0-beta.3` or `v0.27.1`. Beta releases always use `prerelease: true` and
   `make_latest: false`. Stable uses `/releases/latest/`; an older recovered stable version cannot
   move that pointer backwards. Historical releases and immutable tags are retained.
7. After preparing a stable tag, refresh development automation for work accumulated since the
   promotion. No new changes means no duplicate release PR.

## Local development builds

Nightly publication is disabled. There is no scheduled or manually dispatched Nightly workflow,
and the shared publisher rejects Nightly tags, including attempts to resume historical drafts.
Use `pnpm build:local` to test development changes without creating public tags or releases.
Historical Nightly version metadata remains readable for compatibility.

## Versions and changelog

`feat` increases minor. Other development changes, including docs, CI and tests, increase patch.
Breaking changes marked with `!` or a `BREAKING CHANGE:` footer increase minor before 1.0,
and major after 1.0. Release commits are omitted from summaries. A batch uses its highest bump.
Explicit Beta versions use the same next stable base with a unique sequence suffix.
The suffix is **`beta.N`, where N is 1 through 9**. Do not publish `beta.10`
or higher. For example, `0.28.0-beta.1`, `0.28.0-beta.2`, then stable `0.28.0`;
the first Beta for the next target is `0.28.1-beta.1`. Before a tenth milestone
would be needed, review and publish the stable promotion PR. If the release is
not ready, fix it and use local builds for intermediate testing; automation stops
rather than publishing an unreviewed stable release or recycling a number.

Allocation reads tags rather than workflow run counters or display titles.
Failed builds reserve their number. Retrying the same permitted source/tag
reuses its draft, including beta.9. Historical formats remain readable and
reserve their original sequence, but cannot be newly published or recovered
outside the current policy. New target versions restart at beta.1.

Updates compare semantic versions across all pages and include stable releases
in the Beta channel. Users on historical `0.28.0-beta.10` or `.11` can therefore
update to `0.28.0` without a compatibility build. Do not rename a release or tag
while keeping binaries with a different embedded version. Exceptional cleanup
or reissue requires explicit authorization, a metadata/tag-history backup, a
validated replacement source and fresh verified installers. Same-version or
downgrade replacements require manual installation; update checks retain their
normal version and signature checks.
Normal publication retains history and never moves existing tags.

The maintained version policy is available in [English](versioning.en-us.md)
and [简体中文](versioning.zh-cn.md).

All six desktop version locations stay synchronized: package.json, Tauri config, the desktop
Cargo manifest and lockfile, the compatibility `.release-please-manifest.json`, and CITATION.cff. The previous
Release Please action is replaced by repository scripts; the manifest remains version metadata.

The changelog has bilingual categories, highlights, expandable detail, PR/commit links and
contributors. Duplicate titles retain their source references and authors. History on main is
preserved byte for byte. Optional Unreleased notes edited since the last promoted dev source
become the new release highlights. An unchanged summary is ignored, so an older cycle cannot
silently describe a newer release; without a new summary, highlights come from current changes.
Generation is deterministic for fixed inputs and date, requires no AI service, and happens in
the PR before main is changed. PR bodies stay short and link to that exact changelog SHA.

Do not edit `release/dev-to-main`; put fixes and version policy changes through dev. Automation
checks actual refs again before updating a generated branch, so old PR base snapshots cannot
hide new changes. It refuses to overwrite main changes outside generated release metadata;
merge such hotfixes into dev through a reviewed PR before promoting again.

## Credentials and protection

Use the short-lived repository `GITHUB_TOKEN`. Enable **Settings → Actions → General → Workflow
permissions → Allow GitHub Actions to create and approve pull requests**. No PAT, App secret,
organization-wide access or Ruleset bypass is needed. Each workflow declares its permissions.
Automation creates PRs but does not approve them or merge them.

Automation writes the PR policy status to the actual head. GitHub may hold a bot-created
PR's `pull_request` CI run for approval (`action_required`). After reviewing the generated
diff and exact head SHA, a maintainer approves that run from the PR's **Checks** tab or its
Actions page. Wait for that PR run's required checks before merging. Approving a workflow
run authorizes its code to execute; it is separate from approving or merging the PR.

Development reports the PR number and prepared SHA in its workflow notice. It does not
approve its own PR run or dispatch another full CI matrix. A separate manual CI run does
not unblock an approval-held PR run. If a dev update replaces the release head, review and
approve the new head's run; an old successful run is insufficient. The privileged policy
workflow executes only the trusted target branch's policy code; it never checks out
contribution code. Required checks remain bound to Actions.

`.github/main-ruleset.json` and `.github/dev-ruleset.json` are the tracked protection definitions.
Both block deletion and force pushes, require PRs and all seven checks, and have no bypass actors.
The merge-method settings are tracked in `.github/repository-settings.json`: squash, rebase and
merge commits are enabled at repository level. The dev Ruleset allows squash/rebase and retains
linear history; main allows merge commits only. Main permits merge history to preserve exact dev
commits. Both merge and squash default to the PR title/body as their commit message. Apply settings
and Ruleset changes via repository settings or the API; editing JSON alone does not apply them.

PR policy validates the title and every commit subject as Conventional Commits. This applies
to both contribution merge methods, so switching to rebase cannot silently introduce messages
that bypass semantic versioning. It checks the complete commit list against the current PR head
and rejects incomplete history (including PRs beyond GitHub's 250-commit listing limit).
The policy retries inconsistent API snapshots with bounded backoff after ref updates, while
still rejecting incomplete history once retries are exhausted. Generated PR checks must
match the exact prepared head; recovery rechecks policy without duplicating CI, even if
the PR already exists.
Immutable source-file reads also retry transient GitHub server errors (500/502/503/504), with
at most four attempts and 1/2/4-second backoff. Permanent permission or validation errors fail immediately.
The generated release PR retains all development commits and one preparation commit. Policy checks
both preparation parents against the recorded main/dev refs and rejects changes outside release
metadata. Legacy single-parent preparations are regenerated even if their source marker is current.
Stable publication rejects squash/rebase of a history-preserving preparation and any merged tree
that differs from the reviewed tree. The privileged policy workflow reads only commit metadata
and trusted base-branch code, never executes contribution code.

Release collection reads the actual retained commit messages after either merge method, taking
the highest semantic bump across the batch. Rebased commits are associated with their merged
PR even when their SHA is not the PR's final merge SHA. CHANGELOG retains their individual
titles, PR/commit links, original commit authors, PR authors and recognized coauthor trailers.

## Failed builds and recovery

An interrupted build leaves its draft and immutable tag. Dispatch **Release** with that original
`existing_tag` from a branch containing the current workflow.
It rebuilds the tagged source, shares the same draft across builders, validates every asset, and
publishes automatically. Already public releases are rejected by the build preparation step;
recovery never replaces public installers. Never move an existing tag or reuse an abandoned version.

Publication checks the tag's immutable commit, channel and branch ancestry. Advancing dev during
a build does not invalidate the selected snapshot or strand its complete draft. A source removed
from branch history is rejected. Historical Beta publication cannot overwrite stable or
newer-version installers; an old stable recovery explicitly keeps the newer stable as latest.

**Publish version → Run workflow → tag** also validates and creates a missing draft for an existing
version tag. **Release → existing_tag** resumes an already staged draft. Both retain the original
source; neither changes tags or rebuilds public packages. Development concurrency serializes only
release-PR maintenance; Beta and version publication have independent workflow groups.

Compiler timings remain optional Actions artifacts, never public desktop
release downloads. The plugin marketplace repository has its own independent release process.

Rust cache restoration is optional: each step has a three-minute ceiling and cache downloads
use a two-minute segment timeout. If a restore fails or times out, disposable hosted runners
discard the affected target directory and Cargo registry/Git cache before compiling from source.
Source files, other Rust workspaces and installed toolchains are retained. Recovery of older
release tags loads this cleanup tool from the workflow source, while building the immutable tag.
Manual **Release** recovery also offers `use_rust_cache: false` to compile from source during
a cache service outage without changing the source tag or cache namespace.
Contribution CI restores shared caches but only main/dev runs save them, avoiding duplicate
PR cache archives. Keep private LAN proxy addresses in local development settings; hosted
runners need their own reachable network route.

## In-app channels, sources and OTA

Updates live inside **Settings → Updates**. The status-bar notification, tray action and
command palette all lead to that same section; they do not create a separate update page.
Checks default to once daily, with every-startup and weekly options. Checking never
downloads or installs a package automatically. Release notes are included in `latest.json`
and displayed in a collapsed Markdown section.

- **Stable** uses the latest public stable manifest and excludes prereleases.
- **Public beta (Beta)** selects the greatest published stable/Beta version with `latest.json`.
- Nightly publication is disabled and is not an in-app update channel. Legacy Nightly preferences migrate
  to Stable. Stable/Beta discovery excludes daily snapshots.
- Discovery follows GitHub release pagination and compares SemVer rather than titles or list order.
  Drafts, incomplete releases and mismatched prerelease flags are excluded. A source outage is an
  error rather than an up-to-date result. API discovery is bounded to ten pages.
- If the GitHub API is rate limited or unavailable, Beta checks use GitHub's public Atom
  feed of recent published releases through the same configured proxy. This fallback covers recent
  entries, not the full release history. It compares SemVer and verifies each selected tag against
  its `latest.json`; stale entries whose manifest returns 404 are skipped. Network errors and invalid
  manifests still fail the check. It never disables HTTPS, version checks or package signatures.
  Timeout, connection and API quota failures have distinct messages.
- Switching back to Stable never automatically downgrades a newer prerelease. It waits for a stable
  version greater than the installed build. All source/channel changes invalidate a previous update
  selection, and cannot occur during an installation.

Fresh installations always default to Stable, including Beta builds. Public beta
requires an explicit selection; development snapshots are not offered. Existing Stable/Beta
preferences are retained, while legacy Nightly preferences migrate to Stable.

The official source is **GitHub**. There is no bundled third-party mirror. A **custom HTTPS
source** can serve standard Tauri manifests at a template such as
`https://updates.example.com/{channel}/latest.json`. The placeholder must occur exactly
once in the path, expanding to `stable` or `beta`. Credentials, query strings and fragments
are rejected. A Beta check queries stable/Beta concurrently and chooses the newest eligible
version. An unavailable channel can return HTTP 204.
The requested endpoints must otherwise be reachable. This is a manifest service, not a generic GitHub proxy prefix.

Mirror operators copy verified `latest.json` and the corresponding signed updater packages
only after publication. Preserve version, signatures and release notes; replace package
URLs with their HTTPS mirror locations. Publishing manifests atomically avoids half-built
updates. Mirror data never replaces the application's embedded verification key. The
application-update proxy in Network settings applies to source discovery, manifests and
package downloads; the custom source itself is not a proxy setting.

`requireSignedVersion` also binds the announced version to the signed package. A mirror
cannot replay an older signed installer under a newer manifest version. Legacy packages
without a version in their trusted signature comment must be updated manually.

The existing release pipeline already produces **signed full-package OTA updates** for
Windows and AppImage installations. Installation retains the exact package chosen by the
check, verifies its signature and restarts the app. Checks and installs share an exclusive
operation guard, and progress events are throttled to avoid flooding the UI. This is not
binary delta patching: extra differential formats are unnecessary for the current updater.
Unsigned macOS and Linux system packages can still check their selected channel and open
the corresponding release for manual installation. Development builds do not self-update.
