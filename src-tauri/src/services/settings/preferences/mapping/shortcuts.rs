//! Explicit public field to private preference mapping.
pub(super) const FIELDS: &[(&str, &str)] = &[
    ("bindings", "keyboardShortcuts"),
    ("rules", "shortcutRules"),
    ("showDetails", "showShortcutDetails"),
];
