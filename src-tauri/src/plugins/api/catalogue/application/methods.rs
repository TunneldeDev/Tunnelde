use super::ApiMethod;

pub const METHODS: &[ApiMethod] = &[
    method!(
        "app.info",
        ["app.read"],
        "{}",
        "Read application metadata, platform and preference schema; no credentials."
    ),
    method!(
        "app.openExternal",
        ["app.openExternal"],
        "{url:string}",
        "Open an http/https URL with the system browser."
    ),
];
