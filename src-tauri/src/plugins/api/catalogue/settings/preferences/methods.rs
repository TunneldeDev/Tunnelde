use super::ApiMethod;

pub const METHODS: &[ApiMethod] = &[
    method!("preferences.schema", ["settings.read"], "{}", "Read versioned preference groups and fixed input schemas; excludes credentials and host-controlled provider selection."),
    method!("preferences.snapshot", ["settings.read"], "{}", "Read detached public preference values, platform defaults and a persistent global revision."),
    method!("preferences.update", ["settings.write"], "{revision:string,changes:object}", "Compare the global revision and replace explicitly supplied public fields; rejects unknown or invalid values without silently sanitizing them."),
];
