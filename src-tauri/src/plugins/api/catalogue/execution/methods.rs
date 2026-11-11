use super::ApiMethod;

pub const METHODS: &[ApiMethod] = &[
    method!("runners.deploy", ["ssh.exec", "fs.read", "sftp.write"], "{sessionId:string,platform:posix|windows,directory:string,runnerPath:string,executable:string}", "After explicit confirmation, deploy an optional selected native helper and this plugin into a fresh user directory. Never install Node or modify services."),
    method!("runners.start", ["ssh.exec"], "{sessionId:string,directory:string,config:object,secrets?:object}", "Start a durable plugin runner using a previously approved deployment; secrets travel over SSH stdin, not files or argv."),
    method!("runners.startInitialized", ["ssh.exec"], "{sessionId:string,directory:string,configuration:object,secrets?:Record<string,string>}", "Start an explicitly opted-in approved deployment using helper feature runner.initialize-config.v1. Configuration (at most 200 KiB) and secrets use stdin/initialize, never host config files or argv; the combined RPC remains subject to the 256 KiB request limit. Does not seed helper storage and never falls back to file transport. Plugins may explicitly persist data. Existing runners.start/recovery remain available."),
    method!("runners.list", ["ssh.exec"], "{}", "Read this plugin's durable runner records, including stopPending for unreachable revoked tasks."),
    method!("runners.review", ["ssh.exec"], "{sessionId:string,runnerId:string,directory:string,kind:destination|control}", "Request native consent to bind an unknown legacy destination or hand control of one durable task to the current authorized package. Exact record and connection rechecked; never starts, sends or clears a stop request. Returns {reviewed:boolean}."),
    method!("runners.send", ["ssh.exec"], "{sessionId:string,runnerId:string,message:object}", "Enqueue an RPC request or approval response for this plugin's own remote runner."),
    method!("runners.poll", ["ssh.exec"], "{sessionId:string,runnerId:string,afterSeq?:number}", "Read sequenced durable runner events and pending approvals after reconnect."),
    method!("runners.status", ["ssh.exec"], "{sessionId:string,runnerId:string}", "Read this plugin's remote runner status."),
    method!("runners.stop", ["ssh.exec"], "{sessionId:string,runnerId:string}", "Persist and request stopping a remote runner; does not claim that an unreachable process has stopped."),
    method!("tasks.start", [], "{executable:string,args?:string[],cwd?:string,sessionId?:string,platform?:posix|windows,timeoutMs?:number}", "Start an explicitly selected executable; requires process.exec locally or ssh.exec remotely. Return taskId. Separate bounded stdout/stderr; default 30 minutes, maximum 24 hours."),
    method!("tasks.list", [], "{}", "List this runtime's own background processes."),
    method!("tasks.status", [], "{taskId:string}", "Read this runtime's own process status and exit code."),
    method!("tasks.readOutput", [], "{taskId:string,afterSeq?:number}", "Read bounded sequenced stdout/stderr events; truncated reports expired output."),
    method!("tasks.write", [], "{taskId:string,data:string}", "Write UTF-8 to this runtime's own process stdin; at most 128KiB."),
    method!("tasks.closeInput", [], "{taskId:string}", "Close this runtime's own process stdin."),
    method!("tasks.cancel", [], "{taskId:string}", "Stop this runtime's own process; local process trees are terminated, remote server signal support may vary."),
];
