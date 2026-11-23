use super::ApiMethod;

pub const METHODS: &[ApiMethod] = &[
    method!("fonts.catalogue", ["settings.read"], "{}", "Read locally installed and imported font families with source references and monospace hints. No file paths or font bytes. Font selections use preferences.update; import and deletion require the native settings UI."),
    method!(
        "settings.get",
        ["settings.read"],
        "{}",
        "Read application preferences."
    ),
    method!(
        "settings.update",
        ["settings.write"],
        "{patch:object}",
        "Update and sanitize preferences through the normal settings service."
    ),
];
