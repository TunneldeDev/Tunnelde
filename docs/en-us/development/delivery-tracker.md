# Delivery tracker

This is the durable, executable plan for the current rollout. Keep it current when work merges,
CI completes, an acceptance check is performed or a release becomes public.

Issue #468 is the long-running acceptance issue. Its opening body and early comments are a
historical delivery log, not a current status page. The current execution state is this page plus
the latest Issue comments. Do not treat an old snapshot in the issue body as a new blocker.

## Operating rules

- Track work as `done`, `in progress`, `blocked` or `pending`. A merged PR is `done` only when its
  exact-head required checks passed and its acceptance evidence is recorded.
- P0/P1 failures block a release. P2 polish may ship later when the primary flow is usable.
- Publish a Beta after roughly one to three coherent features. A stable release must bind to a
  published, explicitly accepted Beta from the same product source.
- The generated `release/dev-to-main` PR stays Draft while development continues. Only the final
  reviewed head is marked Ready for review, which starts its exact-head PR CI. Do not dispatch a
  manual CI run as a substitute for that lifecycle.
- Do not close Issue #468 or claim rollout completion while any required acceptance item remains.

## Current snapshot

| Item                      | State     | Evidence                                                                                 |
| ------------------------- | --------- | ---------------------------------------------------------------------------------------- |
| Development branch        | current   | `dev` at `c8c621e7`; PR #532 exact-head CI `45039243367` passed all checks.              |
| Stable channel            | published | `v2.7.1` remains the latest stable release.                                              |
| Beta channel              | published | `v2.8.0-beta.3`, immutable tag `5a57f60e`; publish run `45026361923` verified 13 assets. |
| Release promotion PR      | draft     | PR #520 at `fa84061e`; keep Draft until final review and merge.                          |
| Remaining Issue #468 work | active    | See `R1`–`R5` below.                                                                     |

## Execution queue

Work top to bottom unless a release blocker requires immediate attention. Update the row and the
Issue comment as soon as evidence changes.

| ID  | Workstream                                          | State       | Next action / completion evidence                                                                                                                                                                                                                                          | Release gate                                                                   |
| --- | --------------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| R1  | Genuine factoryless/legacy plugin view presentation | pending     | Present legacy registered renderers without fake factories or activation replay. If a renderer cannot move across WebViews, reject the transfer and require explicit state-loss consent; preserve the source otherwise. Evidence must include negative and positive tests. | Required before final rollout acceptance; not a reason to claim support early. |
| R2  | Physical pointer and cross-window drag              | pending     | Verify capture/release, outside-window detach and cross-window drops on Windows and Linux, including negative coordinates, multiple displays and mixed DPI. Record OS, display scale and the exact app build.                                                              | Required before final rollout acceptance.                                      |
| R3  | Real SSH/FUSE continuity                            | pending     | Exercise real SSH and FUSE recovery, cleanup, reconnect and retained state. Test seams alone do not satisfy this item. Record the peer, platform and recovery evidence.                                                                                                    | Required before final rollout acceptance.                                      |
| R4  | Intermittent detached-panel error                   | in progress | PR #528 fixed the deterministic 30-second grant-expiry path. Reproduce the original scenario on the installed Beta and inspect structured `panel.window.*` diagnostics. Keep the issue open if any unclassified failure remains.                                           | Required before final rollout acceptance.                                      |
| R5  | Final rollout acceptance and release                | pending     | Complete R1–R4, publish an accepted `v2.8.0-beta.*` from the reviewed source and only then prepare the stable release.                                                                                                                                                     | Blocks `v2.8.0` stable.                                                        |

## Release nodes

| Node                 | State     | Evidence                                                                                             |
| -------------------- | --------- | ---------------------------------------------------------------------------------------------------- |
| Stable `v2.7.1`      | published | Latest stable baseline.                                                                              |
| Beta `v2.8.0-beta.1` | published | #519 and #521.                                                                                       |
| Beta `v2.8.0-beta.2` | published | #523 and #524; immutable tag `7e226069`; run `45011603981` verified 13 assets.                       |
| Beta `v2.8.0-beta.3` | published | #528 and the draft-release/CI fixes; immutable tag `5a57f60e`; run `45026361923` verified 13 assets. |
| Next Beta            | pending   | Allocate after the next one to three coherent features and exact-head CI.                            |
| Stable `v2.8.0`      | blocked   | Requires an accepted `v2.8.0-beta.*` and a reviewed release PR from the same product source.         |

## Release PR lifecycle

1. Development automation creates or refreshes `release/dev-to-main` as a Draft PR.
2. Draft refreshes do not run the full application CI matrix; this avoids spending a full matrix on
   every development push.
3. When the release batch is final, review the exact head and mark that PR Ready for review.
4. Wait for the exact-head full PR CI to pass. Never merge a stale head or bypass a failed check.
5. Merge with **Create a merge commit**. Stable publication tags the reviewed merge and verifies
   all four desktop builds, signatures and `latest.json` before publishing.
6. If development resumes after the PR becomes Ready, convert it back to Draft before refreshing
   its branch and head.

## Update procedure

1. Update the affected row as soon as a PR merges, a release publishes or a blocker appears.
2. Link immutable commits, CI run IDs, release tags and acceptance evidence rather than relying on
   chat history.
3. Keep this page and the latest Issue #468 comments consistent. The historical issue body must not
   be copied forward as if it were current status.
