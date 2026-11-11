use super::ApiMethod;

pub const METHODS: &[ApiMethod] = &[
    method!("storage.observe", [], "{revision?:string}", "Observe this plugin's existing persistent JSON map with an opaque value-bound revision and optional snapshot {version:1,revision,values}. Initial reads return changed:true; matching revisions omit snapshot. No other plugin identity, host storage path, keyring secret or migration control is accepted. Stored JSON is bounded to 256KiB and depth64, with finite numbers, safe integral numbers and valid storage keys; encoded response is at most 257KiB. Revision is 1-128 UTF-8 bytes without controls; null and extra fields are rejected. Rechecks current runtime authorization after I/O. Reads do not write; legacy files and stable get/set/delete stay compatible. Latest-state polling, not a per-write event log; identical values and ABA may coalesce. Detect support with api.describe."),
    method!("secrets.get", ["secrets"], "{key:string}", "Read this plugin's own OS-keyring secret; return string or null. Never exposes SSH credentials."),
    method!("secrets.set", ["secrets"], "{key:string,value:string}", "Store this plugin's own secret in the operating system keyring, at most 16KiB."),
    method!("secrets.delete", ["secrets"], "{key:string}", "Delete this plugin's own keyring secret."),
    stable_method!("storage.get", [], "{key:string}", "Read plugin-scoped JSON data. Keys use 1–128 ASCII letters, digits, dot, hyphen or underscore.", "0.21.0"),
    stable_method!("storage.set", [], "{key:string,value:JSON}", "Persist plugin-scoped JSON data, at most 256KiB total per plugin.", "0.21.0"),
    stable_method!("storage.delete", [], "{key:string}", "Remove a key from plugin-scoped JSON data.", "0.21.0"),
];
