# Shared UI controls

Use `src/components/ui/` for interactive controls rather than duplicating controls
or their geometry in feature styles. Existing wrappers include `Button`,
`IconButton`, `Input`, `Textarea`, `Select`, `SearchField`, `Switch`, `Field`, menus
and dialogs. Compose these primitives; do not wrap every semantic HTML element.

`layout/Disclosure` provides a native, keyboard-operable expandable section with
a consistent heading and status summary. Interface-provider settings use it to
stay compact by default and expand automatically when filtering settings. The
collapsed summary includes customized and unavailable selection counts; opening
the section never starts a plugin or saves a selection.

`Switch` lives in `form/Switch.tsx` (`form/Field.tsx` keeps a compatibility export).
It supports native button attributes, `ref`, `className` and `style`; its controlled
state, role and button type remain owned by the component. `SwitchRow` adds an
associated label, an optional accessible hint and a shrink-safe text/control row.
Use it for a setting with an explanatory paragraph. Long text wraps instead of
compressing the switch. Standalone switches retain the same non-shrinking track.

Customize switches through scoped CSS properties:

- `--td-switch-width`, `--td-switch-height` (defaults: 32px and 18px; width must be
  at least the height, height greater than 6px). Thumb size and travel follow them.
- `--td-switch-track`, `--td-switch-border`, `--td-switch-active`.
- `--td-switch-thumb`, `--td-switch-thumb-active`.
- `--td-control-row-gap` (default: 16px).

Colors fall back to the existing theme tokens. Keep layout constraints in the
shared component, feature-specific arrangement in feature CSS, and preserve
native keyboard, focus, disabled and label behavior. Host file import/export use
`FileInput`/`FileOutput`; download arrows are reserved for download actions.

## Help and passwords in compact surfaces

`overlay/Tooltip` provides delayed hover, focus and touch/click help, Escape-first
dismissal, hoverable content, viewport clamping and unmount cleanup. Its portal
avoids scroll-container clipping. Associate the trigger with the description ID
passed to its render callback. `form/HelpHint` supplies the circled question mark
beside a label; keep it outside `<label>` so help never toggles the control.
Native `title` alone is not adequate for keyboard or touch users.

`Field` and `SwitchRow` inherit `HelpPresentationProvider`: full pages default to
`inline`, `Dialog` defaults to `tooltip`, and compact panels should provide the
same context. Override with `hintPresentation` where needed. Dialog's `help`
appears beside its title, not in a separate body row. Only static explanations
belong in help: errors, results, security warnings, consent and generated-password
acknowledgments remain visible (`inline` when necessary). Never infer which text
to hide from its wording or CSS class.

`PasswordInput` embeds reveal/hide and optional explicit copy actions on the
right. It supports controlled visibility; revealing never changes the password or
submits its form. Copy requires an explicit callback and never reads the clipboard.
Host export selection actions sit before Cancel in the footer and affect only
shown hosts when filtering.

## VS Code workbench reference

Use VS Code's workbench interaction model as the reference, not a wholesale
visual reskin. Keep Tunnelde's branding, existing theme tokens and continuous
corners. Prefer small, shared-component corrections over feature-local styling.

- Separate the workbench area, view container, section/group and content row.
  Do not style a forwarding rule like its group heading. Merge redundant title
  levels when a container holds only one view; keep its actions discoverable.
- A view has one identity and one business-resource owner across sidebar, dock,
  floating and independent-window presentations. Moving or hiding is not stopping
  work. Restore drafts, selection, scroll and focus; failed moves keep the source.
- Put related creation actions together in the title toolbar. Less frequent,
  context-specific actions belong in the shared overflow/context menu. Toolbar,
  menu and keyboard entry points must invoke the same command and enabled state.
- Offer keyboard alternatives to drag-only operations, visible focus and
  accessible labels. Empty, loading, error and disconnected states are distinct;
  do not turn a loading or error placeholder into a ready destination.
- Match extension concepts (commands, context, contribution points, scoped
  events/disposables) where useful, but advertise only implemented capabilities.
  VS Code is a design reference, not a claim of API/binary compatibility or a
  reason to weaken permissions, lifecycle fences or native ownership checks.

Reference implementations: VS Code
[`PanelPart`](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/browser/parts/panel/panelPart.ts)
and
[`ViewPaneContainer`](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/browser/parts/views/viewPaneContainer.ts).

[UI/UX surface catalog](ui-surface-catalog.md)

Keep important information prominent: errors/conflicts use error color, tint or border, an icon and
a reason. Color alone, tooltips and silently added controls are insufficient. Generated export
passwords require a separate save confirmation with selectable password, explicit copy, continue
and cancel; confirmation precedes file export. Import previews identify direct/dependent conflicts
and explain both blocking reasons and their resolution.
