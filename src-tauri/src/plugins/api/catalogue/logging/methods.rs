use super::ApiMethod;

pub const METHODS: &[ApiMethod] = &[
    stable_method!("log", ["log"], "{message:string,level?:string,domain?:string,operation?:string,requestId?:string,fields?:object}", "Write a bounded local log at its requested severity; return null on acceptance, not durable delivery. Host supplies plugin identity and runtime generation; domain is plugin-scoped. Optional structured fields redact credential keys and URL credentials/query/fragment. Existing message/level calls remain supported; structured options require 0.33.0-beta.5 or later. Subject to configured log filter and nonblocking writer; never include secrets in message text.", "0.21.0"),
];
