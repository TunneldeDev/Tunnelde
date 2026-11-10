//! Explicit public field to private preference mapping.
pub(super) const FIELDS: &[(&str, &str)] = &[
    ("autoCheck", "autoCheckUpdates"),
    ("channel", "updateChannel"),
    ("source", "updateSource"),
    ("sourceUrl", "updateSourceUrl"),
    ("interval", "updateCheckInterval"),
];
