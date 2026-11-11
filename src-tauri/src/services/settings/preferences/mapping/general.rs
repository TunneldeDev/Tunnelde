//! Explicit public field to private preference mapping.
pub(super) const FIELDS: &[(&str, &str)] = &[
    ("language", "language"),
    ("closeToTray", "closeToTray"),
    ("releaseWebviewInTray", "releaseWebviewInTray"),
    ("lightweightMode", "lightweightMode"),
    ("showDockIconInBackground", "showDockIconInBackground"),
];
