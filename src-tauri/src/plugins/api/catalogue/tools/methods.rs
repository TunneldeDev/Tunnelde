use super::ApiMethod;

pub const METHODS: &[ApiMethod] = &[
    method!("tools.invoke", [], "{method:string,params:object,mode:ask|approve|full|readOnly,scope:{sessionIds?:string[],hostIds?:string[],localRoots?:string[],remoteRoots?:{sessionId:string,path:string}[]},review?:{approved:boolean,reason:string},clientId?:string,requestId?:string}", "Execute an allowlisted AI/MCP tool after permission, target scope and approval checks. ReadOnly rejects every command and mutation. Review may only be supplied by a trusted plugin's independent reviewer."),
    method!("tools.cancel", [], "{requestId:string}", "Cancel this plugin runtime's pending tool invocation. Undelivered SSH connections created by that invocation are closed; a completed invocation's delivered connection is unaffected. Already completed remote operations cannot be rolled back."),
    method!("tools.revokeClient", [], "{clientId:string}", "Permanently revoke this client ID for the current plugin runtime generation, cancel its pending tool invocations and release its tasks, transfers and SSH connections. Other clients, direct plugin connections, user-created connections and replacement runtimes are unaffected. A new client identity is required to resume."),
];
