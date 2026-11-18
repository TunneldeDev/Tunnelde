use super::ApiMethod;

pub const METHODS: &[ApiMethod] = &[
    method!("forwards.automation.list", ["forwards.read"], "{}", "Read revisioned saved rules, runtime identities, per-rule autoStart/autoRetry options and recovery status. These are the same settings displayed by the native forwarding panel; legacy forwards.list is unchanged."),
    method!("forwards.automation.save", ["forwards.write"], "{id:string,expectedRevision:string,automation:{autoStart:boolean,autoRetry:boolean}}", "Save automation options against an existing rule's exact revision. Stale edits fail without changing the rule. These host-owned preferences persist across plugin stop/revocation, like a native settings edit. Enabling autoStart takes effect on the next application start; it does not connect immediately."),
    method!("forwards.list", ["forwards.read"], "{}", "Read saved TCP forwarding rules and running status."),
    method!("forwards.save", ["forwards.write"], "{rule:ForwardRule}", "Create or update a validated TCP forwarding rule; active rules must be stopped first."),
    method!("forwards.remove", ["forwards.write"], "{id:string}", "Remove a saved forwarding rule and stop its active connections."),
    method!("forwards.start", ["forwards.write"], "{id:string,sessionId:string}", "Start a saved forward through its host's active authenticated session; stopped on plugin revocation."),
    method!("forwards.startMany", ["forwards.write"], "{sessionId:string,items:{id:string,expectedRevision:string}[]}", "Start up to 16 distinct saved rules in input order through an existing authenticated session for their host. Recheck each revision and authorization before admitting its listener. Return ordered started, failed or notStarted outcomes; failures do not roll back earlier starts. The batch has a 90-second budget and never creates SSH sessions. Listeners remain owned by the plugin runtime."),
    method!("forwards.stop", ["forwards.write"], "{id:string}", "Stop a forwarding listener and its active connections."),
];
