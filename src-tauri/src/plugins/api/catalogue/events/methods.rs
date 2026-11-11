use super::ApiMethod;

pub const METHODS: &[ApiMethod] = &[
    stable_method!("events.publish", [], "{event:string,payload?:JSON}", "Emit an advisory UI event from the current approved runtime. Event names use 1-128 ASCII letters, digits, dot, underscore, colon or hyphen. Omitted payload becomes null; extra fields cannot replace host-supplied pluginId/generation. Shared 256KiB UTF-8 request budget. Return null on transport acceptance, not subscriber acknowledgement or durable delivery. No replay, cross-request completion order or permission grant is promised; consumers must check runtime generation.", "0.21.0"),
];
