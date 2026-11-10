//! Explicit public field to private preference mapping.
pub(super) const FIELDS: &[(&str, &str)] = &[
    ("profiles", "network.profiles"),
    ("defaultProxy", "network.defaultProxy"),
    ("features", "network.features"),
];
