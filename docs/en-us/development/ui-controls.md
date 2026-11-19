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
