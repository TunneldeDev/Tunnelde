use super::ApiMethod;

pub const METHODS: &[ApiMethod] = &[
    method!("preferences.schema", ["settings.read"], "{}", "Read versioned preference groups and fixed input schemas; excludes credentials and host-controlled provider selection."),
    method!("preferences.snapshot", ["settings.read"], "{}", "Read detached public preference values, platform defaults and a persistent global revision."),
    method!("preferences.observe", ["settings.read"], "{revision?:string}", "Conditional public preference read under the shared settings writer. Omit revision for an initial snapshot; a matching opaque revision returns only version, revision and changed:false. A changed revision includes changed:true and snapshot. Tokens contain 1-128 UTF-8 bytes and no control characters; null and unknown fields are rejected. Each read rechecks settings.read and runtime authorization; no durable subscription, replay or per-commit delivery. Metadata commits can invalidate the global revision."),
    method!("preferences.update", ["settings.write"], "{revision:string,changes:object}", "Compare the global revision and replace explicitly supplied public fields; rejects unknown or invalid values without silently sanitizing them."),
];
