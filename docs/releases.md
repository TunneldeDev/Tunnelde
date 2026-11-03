# Release operations

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
3. The same dev source builds a unique `vX.Y.Z-beta.N` tag. The public prerelease
   is named **Nightly**. All desktop installers, signatures and updater metadata must pass
   verification before publication. Only then is the previous Nightly release retired;
   immutable beta tags remain. Failed/stale builds cannot replace the working Nightly.
4. Review the version and summarized changelog in the release PR, then use **Create a merge commit**
   to merge into main. The release keeps all individual dev commits, the preparation commit and
   an explicit PR merge point. **Stable release** verifies the reviewed parents and tree,
   creates an immutable tag at that exact merged commit before
   creating a draft, then calls **Release** for the four desktop targets.
5. **Verify and publish release** validates all desktop artifacts and `latest.json`, then
   automatically publishes the release as latest. Nightly always uses `prerelease: true`
   and `make_latest: false`; stable desktop updater URLs continue to use `/releases/latest/`.
6. After stable publication, development automation is refreshed to pick up any work that
   arrived while the stable builds were running. No new changes means no duplicate release PR.

The main migration PR itself keeps version 0.26.1 and does not create an extra stable release.
Development preparation waits until the migration metadata exists on main. Set `dev` as the
repository default once its reviewed workflow files are available; **Stable release** dispatches
development preparation after the migration merges. No bot bypass or direct main write is needed.

## Versions and changelog

`feat` increases minor. Other development changes, including docs, CI and tests, increase patch.
Breaking changes marked with `!` or a `BREAKING CHANGE:` footer increase minor before 1.0,
and major after 1.0. Release commits are omitted from summaries. A batch uses its highest bump.
Beta versions use the same next stable base with a unique build sequence suffix.
The suffix is `beta.N`, counted separately for each target stable version. For example,
`0.26.2-beta.1`, `0.26.2-beta.2`, then stable `0.26.2`; the first beta for the next patch
is `0.26.3-beta.1`. A change to the target minor/major version also starts at `beta.1`.
Automation reads immutable tags rather than the workflow's global run counter or the
retired Nightly release. Failed builds reserve their number; retrying the same source
reuses its existing tag and draft without changing published packages. Legacy tags such
as `0.26.2-beta.2.1` remain valid and reserve sequence 2, so the next new source for that
same target uses `0.26.2-beta.3`. Publication compares complete semantic versions, so
a larger target version supersedes older betas even when its sequence restarts at 1.

All eight version locations stay synchronized: package.json, Tauri config, both Cargo manifests
and lockfiles, the compatibility `.release-please-manifest.json`, and CITATION.cff. The previous
Release Please action is replaced by repository scripts; the manifest remains version metadata.

The changelog has bilingual categories, highlights, expandable detail, PR/commit links and
contributors. Duplicate titles retain their source references and authors. History on main is
preserved byte for byte. Optional Unreleased notes from dev become the new release highlights.
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

Automation explicitly dispatches CI on the generated branch and writes the PR policy status
to the actual head. The privileged policy workflow executes only the trusted target branch's
policy code; it never checks out contribution code. Required checks remain bound to Actions.

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
match the exact prepared head; recovery redispatches CI even if the PR already exists.
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
`existing_tag` from a branch containing the current workflow, and optionally `build_helpers`.
It rebuilds the tagged source, shares the same draft across builders, validates every asset, and
publishes automatically. Already public releases are rejected by the build preparation step;
recovery never replaces public installers. Never move an existing tag or reuse an abandoned version.

Publication rechecks the current channel source: an obsolete Nightly cannot replace a newer dev
build, and an old stable draft cannot become latest after main advances. Retry **Development**
or **Stable release** to prepare the current source. A published stable version is not duplicated.
Development workflow concurrency serializes release-branch updates; pending pushes may coalesce
to the newest dev source, avoiding a queue of obsolete installer builds.

Native helpers and compiler timings remain optional Actions artifacts, never public desktop
release downloads. The plugin marketplace repository has its own independent release process.

## In-app channels, sources and OTA

Updates live inside **Settings → Updates**. The status-bar notification, tray action and
command palette all lead to that same section; they do not create a separate update page.
Checks default to once daily, with every-startup and weekly options. Checking never
downloads or installs a package automatically. Release notes are included in `latest.json`
and displayed in a collapsed Markdown section.

- **Stable** uses the latest public stable manifest and excludes prereleases.
- **Public beta (Nightly)** discovers published releases containing `latest.json` and
  selects the greatest eligible stable/beta version using SemVer. A finished stable
  release supersedes its older beta builds. Drafts, alpha builds and incomplete releases
  are excluded. A source outage is an error, never an up-to-date result.
- Switching back to Stable never automatically downgrades a newer prerelease. It waits
  for a stable version greater than the installed build. Existing beta tags stay immutable.

Stable builds default to Stable. New beta installations default to Public beta; saved
preferences always take priority when upgrading an existing installation.

The official source is **GitHub**. There is no bundled third-party mirror. A **custom HTTPS
source** can serve standard Tauri manifests at a template such as
`https://updates.example.com/{channel}/latest.json`. The placeholder must occur exactly
once in the path, expanding to `stable` or `beta`. Credentials, query strings and fragments
are rejected. A beta check queries both manifests and chooses the newest eligible version;
the beta endpoint may return HTTP 204 if no beta is available. Both channel endpoints
must otherwise be reachable. This is a manifest service, not a generic GitHub proxy prefix.

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
