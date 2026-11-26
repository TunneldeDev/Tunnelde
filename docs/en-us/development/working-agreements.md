# Development and UX conventions

These conventions apply to built-in features and plugin contributions. Keep this
page durable; put temporary plans, screenshots and handoff notes in `.tmp/`.

## Product and presentation

- Refine the existing design incrementally. Avoid broad visual redesigns when a
  small hierarchy, spacing or alignment fix resolves the problem.
- Reuse the shared control wrappers and theme tokens. Controls must not shrink
  their switches/icons under long labels. Use continuous-corner surfaces where
  supported and the existing platform fallback; do not invent unrelated radii.
- The default panel is the integrated workbench container, internally composed
  from reusable primitives. Business features supply one content implementation,
  not independent floating and docked variants. Special-purpose surfaces may use
  primitives directly, but this is not the default integration burden.
- Related actions belong together: creation beside creation; refresh and overflow
  follow. Distinguish headings, group labels, content rows and their actions.
- In space-constrained dialogs, place ordinary explanation behind a nearby help
  icon/tooltip. Spacious settings pages may show inline secondary text. Never hide
  security consent, destructive consequences, validation errors or recovery steps
  solely in a tooltip. Keep keyboard/focus access and Escape ordering intact.
- Password visibility belongs inside the input as an eye action. Keep selection
  tools near the footer actions rather than adding an unnecessary full row.
- Native scrolling, text cursors, editor selection/undo, line numbers, consistent
  CJK/Latin monospace metrics and responsive input are core UX, not decorations.

## Ownership, resources and API coverage

- A presentation change moves a view; it must not reconnect SSH, restart plugin
  runtimes, duplicate background work or discard user drafts. Keep one resource
  owner. Hiding and stopping/disconnecting are distinct operations. Explicitly
  closing the last ordinary connection consumer follows the default-on
  disconnect-on-close preference; moving or hiding never does. Every built-in
  panel/page supports floating; only contributed plugin views may opt out.
- Reuse the shared layout/pointer primitives. Preview geometry at most once per
  frame, persist on release, and roll back interrupted gestures. Batch related
  split changes in one owner transaction; do not remount content to resize it.
- Built-in capabilities should have discoverable, permission-checked plugin APIs
  rather than ad-hoc private integrations. Discovery does not grant authority;
  freeze published contracts and add versioned/experimental surfaces separately.
- Host-managed connections and shared configuration belong to the host, not a
  single plugin's UI lifetime. Plugin messaging never grants another plugin's
  permissions or makes untrusted messages authoritative.
- Native window and runtime generations are security boundaries. Do not remove
  main-window checks or duplicate bootstrap just to make an extra WebView work.
  Cross-WebView moves need explicit ownership, cancellation and rollback.
- Do not persist or log plaintext passwords, private keys or secret view drafts in
  layouts. Retain explicit user confirmation for credential-bearing operations.

## Delivery and collaboration

- Use isolated branches/worktrees and reviewable PRs. Never overwrite a dirty
  sibling repository or unrelated user edits. Clean obsolete branches/worktrees
  only after the work is merged and no longer needed.
- Merge PRs individually after complete CI on their exact head, preserving a PR
  record and the linear development history. Update/retest remaining PRs against
  the new base. Resolve known P0/P1 failures before merging/releasing; track nonblocking
  P2 polish for subsequent versions instead of delaying usable primary flows.
  Do not bypass failed checks.
- Publish a beta after roughly one to three coherent features and a final
  acceptance beta after the requested scope is complete. Use the automated
  immutable release snapshot workflow; verify platform builds, release assets,
  signatures and updater metadata. A beta is not a claim of stable acceptance.
- Review the generated stable promotion PR, its exact-head CI and the final
  package/upgrade evidence before merging. A published Beta and separate Release
  acceptance marker are not required.
- Keep English and Chinese development guidance and UI translations aligned.
  Document real limitations instead of marking partially implemented work done.
- Coding subagents may use only `deepseek-ai/DeepSeek-V4.1-Flash` unless the
  maintainer explicitly changes the allowlist. If unavailable, work directly;
  do not silently substitute another model. Contributors implement and revise;
  the coordinating reviewer remains responsible for review, merge and release.

Keep the [UI/UX surface catalog](ui-surface-catalog.md) aligned with UI changes, including location, layout, actions, narrow behavior and states.

Keep important information prominent: errors/conflicts use error color, tint or border, an icon and
a reason. Color alone, tooltips and silently added controls are insufficient. Generated export
passwords require a separate save confirmation with selectable password, explicit copy, continue
and cancel; confirmation precedes file export. Import previews identify direct/dependent conflicts
and explain both blocking reasons and their resolution.

## Fix commits and verification

Use one commit per independent feature or fix, including related regression tests. Maintain both
languages of the UI/UX, design conventions and surface catalog. Squash temporary fixups before
delivery, keeping unrelated fixes in separate commits.

Run type checking, lint, frontend/Rust tests, builds and translation/document checks according to
the change's risk. Check layout changes in wide/narrow panels, expanded/collapsed states and
light/dark themes. Synthetic browser scenes using production components verify layout but do not
replace native-window, real SSH, cross-platform or installer acceptance. Record checks actually
performed and their limits. Distinguish rolling-window transfer speed from average speed since the
current observation baseline, with separate remaining-time estimates. Resume resets the rolling
window but retains the observed average baseline; do not invent historical samples after restart.
