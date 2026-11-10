use super::ApiMethod;

pub const METHODS: &[ApiMethod] = &[
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
