# Contributing

`main` is the default branch and must remain releasable. Create a short-lived branch,
open a pull request and squash merge after the required checks pass. There is no long-lived
`dev` branch. Direct pushes, force pushes and deletion of `main` are blocked, including for bots.
An additional person's approval is not required for the current solo-maintainer workflow.

## PR titles

Use a Conventional Commit title; GitHub uses that title for the squash commit.

| Type                                               | Example                                 | Release effect          |
| -------------------------------------------------- | --------------------------------------- | ----------------------- |
| `feat`                                             | `feat(themes): add background controls` | Minor                   |
| `fix`                                              | `fix(terminal): restore paste`          | Patch                   |
| `perf`, `build`                                    | `build: reduce linker work`             | Patch                   |
| `revert`                                           | `revert: undo broken migration`         | Patch                   |
| `docs`, `test`, `ci`, `chore`, `refactor`, `style` | `docs: explain host authentication`     | No release on their own |

Add `!` before the colon for a breaking change, for example `feat(api)!: replace task transport`.
Breaking changes increase the minor version while the project is below 1.0, and the major version
after 1.0. Use `fix(deps)` for application dependency changes and `ci(deps)` for workflow dependencies.
Keep the PR body to 1–3 sentences describing the change and its purpose, with one short validation
sentence when relevant. GitHub uses it directly as the squash commit body; leave detailed logs in CI.
Do not include credentials.

## Checks

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm build
pnpm version:check
pnpm i18n:check
node --test scripts/release/tests/*.test.mjs
```

Rust changes also require formatting, Clippy and the relevant Cargo tests. CI checks native helpers
on Linux, Windows and macOS. Keep the PR up to date with `main` and resolve all review conversations
before merging. Do not change the required-check names without updating `.github/main-ruleset.json`
and applying its repository Ruleset.

## Releases

Ordinary PRs do not need a version bump. Release Please gathers merged Conventional Commits into
one release PR. A script summarizes merged changes into highlights, categorized details, PR links
and contributors in that release branch. Ordinary PRs do not need to edit `CHANGELOG.md`.
Existing optional Unreleased notes are retained as highlights, and historical entries stay unchanged.
Merge the release PR when the group of changes is ready. Its installers are built into a draft
for manual publication.

See [Release operations](docs/releases.md) for version overrides, credentials and failed-build recovery.
