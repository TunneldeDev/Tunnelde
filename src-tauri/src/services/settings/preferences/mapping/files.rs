//! Explicit public field to private preference mapping.
pub(super) const FIELDS: &[(&str, &str)] = &[
    ("showHidden", "filesShowHidden"),
    ("foldersFirst", "filesFoldersFirst"),
    ("sortBy", "filesSortBy"),
    ("sortDirection", "filesSortDirection"),
    ("iconTheme", "fileIconTheme"),
    ("preload", "preloadDirs"),
    ("preloadCount", "preloadCount"),
];
