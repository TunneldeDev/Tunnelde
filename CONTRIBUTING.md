# Contributing

`dev` is the default branch and the target for contributions. Create a short-lived branch from
`dev`, open a PR to `dev`, and rebase or squash merge after required checks pass. `main` is the stable branch:
only the generated release PR promotes development to it. Both branches block direct pushes,
force pushes and deletion. No additional reviewer is required for the solo-maintainer workflow.

## PR titles and commits

Use a Conventional Commit title; GitHub uses that title for the squash commit.
Every commit subject must use the same format, including when squash merging, because contribution
PRs offer both merge methods. Bodies can contain explanations, breaking-change footers and coauthors.
The PR policy checks every commit, reports invalid commit SHAs and rejects incomplete history.

Use **Rebase and merge** when individual commits are useful to retain and review. Use **Squash and
merge** when intermediate fixes should become one change. Rename or consolidate nonconforming
commits on your contribution branch before merging. Rebase merging preserves individual changes
but creates new commit SHAs. Generated release PRs to `main` allow **Squash** only.

| Type                                               | Example                                 | Release effect |
| -------------------------------------------------- | --------------------------------------- | -------------- |
| `feat`                                             | `feat(themes): add background controls` | Minor          |
| `fix`                                              | `fix(terminal): restore paste`          | Patch          |
| `perf`, `build`                                    | `build: reduce linker work`             | Patch          |
| `revert`                                           | `revert: undo broken migration`         | Patch          |
| `docs`, `test`, `ci`, `chore`, `refactor`, `style` | `docs: explain host authentication`     | Patch          |

Add `!` before the colon for a breaking change, for example `feat(api)!: replace task transport`.
With rebase merging, automated versioning reads every retained commit and uses the highest bump;
the PR title is not substituted for those commits. Put `feat`, `!` and `BREAKING CHANGE:` in the
commits that carry those changes. With squash merging, ensure the final commit title and body
retain those markers. CHANGELOG keeps individual changes, PR references and commit contributors.
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
on Linux, Windows and macOS. Keep the PR up to date with its target branch and resolve all review conversations
before merging. Do not change the required-check names without updating `.github/main-ruleset.json` / `.github/dev-ruleset.json`
and applying its repository Ruleset.

## Releases

Ordinary PRs do not need version bumps or changelog edits. Every `dev` update builds a **Nightly**
prerelease with a unique beta version and maintains one `release/dev-to-main` PR targeting `main`.
That PR contains all development changes since the last promotion, synchronized versions and a
summarized changelog with highlights, categorized details, PR links and contributors. Historical
entries are preserved. Optional Unreleased notes can supply curated highlights.

Review and squash merge that release PR when ready. The exact merged source is tagged, built for
all four desktop targets, verified and automatically published as the latest stable release.
Nightly never replaces the stable updater channel. Do not edit or contribute to the generated
release branch; it is rebuilt from the latest `dev` and `main` refs.

See [Release operations](docs/releases.md) for configuration and failed-build recovery.
