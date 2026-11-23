//! Explicit public field to private preference mapping.
pub(super) const FIELDS: &[(&str, &str)] = &[
    ("theme", "theme"),
    ("accent", "accent"),
    ("colors", "colors"),
    ("density", "density"),
    ("fontSize", "uiFontSize"),
    ("monoFontSize", "monoFontSize"),
    ("monoFont", "monoFont"),
    ("motion", "motion"),
    ("userCss", "userCss"),
    ("titleBarStyle", "titleBarStyle"),
];
