use super::ApiMethod;

pub const METHODS: &[ApiMethod] = &[
    method!("secrets.get", ["secrets"], "{key:string}", "Read this plugin's own OS-keyring secret; return string or null. Never exposes SSH credentials."),
    method!("secrets.set", ["secrets"], "{key:string,value:string}", "Store this plugin's own secret in the operating system keyring, at most 16KiB."),
    method!("secrets.delete", ["secrets"], "{key:string}", "Delete this plugin's own keyring secret."),
    stable_method!("storage.get", [], "{key:string}", "Read plugin-scoped JSON data. Keys use 1–128 ASCII letters, digits, dot, hyphen or underscore.", "0.21.0"),
    stable_method!("storage.set", [], "{key:string,value:JSON}", "Persist plugin-scoped JSON data, at most 256KiB total per plugin.", "0.21.0"),
    stable_method!("storage.delete", [], "{key:string}", "Remove a key from plugin-scoped JSON data.", "0.21.0"),
];
