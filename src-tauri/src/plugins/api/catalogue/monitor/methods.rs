use super::ApiMethod;

pub const METHODS: &[ApiMethod] = &[
    method!(
        "monitor.system",
        ["monitor.read"],
        "{}",
        "Read local CPU, memory, disk and network statistics."
    ),
    method!(
        "monitor.stats",
        ["monitor.read"],
        "{sessionId:string}",
        "Sample remote system statistics."
    ),
    method!(
        "monitor.processes",
        ["monitor.read"],
        "{sessionId:string}",
        "List remote processes."
    ),
    method!(
        "monitor.kill",
        ["monitor.write"],
        "{sessionId:string,pid:number}",
        "Send TERM to a remote process; protected process validation still applies."
    ),
];
