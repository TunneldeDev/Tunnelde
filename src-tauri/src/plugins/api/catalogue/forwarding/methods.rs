use super::ApiMethod;

pub const METHODS: &[ApiMethod] = &[
    method!("forwards.list", ["forwards.read"], "{}", "Read saved TCP forwarding rules and running status."),
    method!("forwards.save", ["forwards.write"], "{rule:ForwardRule}", "Create or update a validated TCP forwarding rule; active rules must be stopped first."),
    method!("forwards.remove", ["forwards.write"], "{id:string}", "Remove a saved forwarding rule and stop its active connections."),
    method!("forwards.start", ["forwards.write"], "{id:string,sessionId:string}", "Start a saved forward through its host's active authenticated session; stopped on plugin revocation."),
    method!("forwards.stop", ["forwards.write"], "{id:string}", "Stop a forwarding listener and its active connections."),
];
