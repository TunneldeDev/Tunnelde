# Delivery tracker

This is the durable delivery ledger for the current rollout. Keep it current when work merges,
CI completes or a release becomes public. Issue #468 remains the detailed acceptance record;
this page exists so contributors can see priorities and release gates without reading a long
issue comment history.

## Operating rules

- Track work as `done`, `in progress`, `blocked` or `pending`. A merged PR is `done` only when its
  exact-head required checks passed and its acceptance evidence is recorded.
- P0/P1 failures block a release. P2 polish may ship later when the primary flow is usable.
- Publish a Beta after roughly one to three coherent features. A stable release must bind to a
  published, explicitly accepted Beta from the same product source.
- The generated `release/dev-to-main` PR stays draft while development continues. Only the final
  reviewed head is marked ready for review, which starts its exact-head PR CI.
- Do not close Issue #468 or claim rollout completion while any required acceptance item remains.

## Current milestone

| Item                                                  | State       | Evidence / next action                                                                                                                                                                               |
| ----------------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unified structured error and diagnostics architecture | done        | PR #523; exact-head CI `45008474774` passed; documented in [errors-and-diagnostics](errors-and-diagnostics.md).                                                                                      |
| Tab drag insertion-line affordance                    | done        | PR #524; exact-head CI `45010017998` passed after rebasing onto #523.                                                                                                                                |
| Beta containing #523 and #524                         | done        | [`v2.8.0-beta.2`](https://github.com/TunneldeDev/Tunnelde/releases/tag/v2.8.0-beta.2) published from `7e226069`; run `45011603981` passed all platforms and final verification; 13 non-empty assets. |
| Release PR lifecycle: draft by default                | in progress | Automation, CI gating, tests and release docs updated in this branch; merge after exact-head CI.                                                                                                     |
| Issue #468 remaining rollout                          | pending     | See the acceptance checklist below and the issue itself.                                                                                                                                             |

## Issue #468 remaining acceptance

| Workstream                                          | State       | Completion condition                                                                                                                                      |
| --------------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Genuine factoryless/legacy plugin view presentation | pending     | Present legacy views without fake factories or activation replay; require explicit state-loss consent where state cannot be restored.                     |
| Physical pointer and cross-window drag              | pending     | Verify capture/release, outside-window detach and cross-window drops on Windows/Linux, including negative coordinates, multiple displays and mixed DPI.   |
| SSH/FUSE continuity                                 | pending     | Exercise real SSH and FUSE recovery, cleanup, reconnect and retained state; test seams alone do not satisfy this item.                                    |
| Intermittent detached-panel error                   | in progress | Reproduce with the structured `panel.window.*` diagnostics shipped in #523, identify the pointer grant/release race, fix it and retain a regression test. |
| Final rollout acceptance                            | pending     | Complete the required items above, publish an accepted Beta and only then prepare the stable release.                                                     |

## Release nodes

| Node                 | State     | Evidence                                                                                              |
| -------------------- | --------- | ----------------------------------------------------------------------------------------------------- |
| Stable `v2.7.1`      | published | Latest stable baseline.                                                                               |
| Beta `v2.8.0-beta.1` | published | #519 and #521.                                                                                        |
| Beta `v2.8.0-beta.2` | published | #523 and #524; immutable tag `7e226069`; release run `45011603981` succeeded with 13 verified assets. |
| Next Beta            | pending   | Allocate after the next one to three completed features and verified exact-head CI.                   |
| Stable `v2.8.0`      | blocked   | Requires accepted `v2.8.0-beta.*` and a reviewed release PR from the same product source.             |

## Update procedure

1. Update the affected row as soon as a PR merges, a release publishes or a blocker appears.
2. Link immutable commits, CI run IDs, release tags and acceptance evidence rather than relying on
   chat history.
3. Keep this page and Issue #468 consistent; neither is a substitute for the other.
