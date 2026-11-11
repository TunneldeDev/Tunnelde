use super::ApiMethod;

pub const METHODS: &[ApiMethod] = &[
    method!(
        "history.list",
        ["history.read"],
        "{hostId:string,limit?:number}",
        "Read saved command history, at most 500 rows."
    ),
    method!(
        "history.record",
        ["history.write"],
        "{hostId:string,command:string}",
        "Record a command for an existing saved host."
    ),
    method!(
        "history.delete",
        ["history.write"],
        "{id:number}",
        "Delete one command-history entry."
    ),
    method!(
        "history.clear",
        ["history.write"],
        "{hostId:string}",
        "Clear a saved host's command history."
    ),
];
