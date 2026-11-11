use super::ApiMethod;

pub const METHODS: &[ApiMethod] = &[
    method!("profiles.observe", ["settings.read"], "{revision?:string}", "Observe bounded profile metadata under a consistent repository read: schema version, opaque revision, changed and an optional snapshot with at most 32 id/name/updatedAt items. No settings contents, credentials or activation. Matching revisions omit the snapshot. Revision is 1-128 UTF-8 bytes without control characters; null and unknown fields are rejected. Native saves/deletes atomically renew a persistent token; legacy metadata changes invalidate it too. Rechecks current runtime authorization. Latest-state polling, not durable per-commit delivery; detect support with api.describe."),
];
