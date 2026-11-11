use super::ApiMethod;

pub const METHODS: &[ApiMethod] = &[
    method!(
        "clipboard.readText",
        ["clipboard.read"],
        "{}",
        "Read the system text clipboard."
    ),
    method!(
        "clipboard.writeText",
        ["clipboard.write"],
        "{text:string}",
        "Replace the system text clipboard."
    ),
];
