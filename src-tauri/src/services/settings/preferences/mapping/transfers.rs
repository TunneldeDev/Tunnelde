//! Explicit public field to private preference mapping.
pub(super) const FIELDS: &[(&str, &str)] = &[
    ("optimization", "transferOptimization"),
    ("compression", "transferCompression"),
    ("concurrency", "transferConcurrency"),
    ("chunkKib", "transferChunkKib"),
    ("requests", "transferRequests"),
    ("uploadLimitKib", "transferUploadLimitKib"),
    ("downloadLimitKib", "transferDownloadLimitKib"),
];
