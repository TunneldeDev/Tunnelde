use super::ApiMethod;

pub const METHODS: &[ApiMethod] = &[
    stable_method!("sessions.list", ["sessions.read"], "{}", "List active SSH session metadata; no passwords or private keys.", "0.21.0"),
    method!("sessions.connect", ["ssh.exec"], "{request:SshConnectRequest}", "Connect a saved host with normal host-key verification; never auto-trust a server. The connection belongs to this runtime generation and closes on stop, crash, revocation or replacement unless explicitly transferred by sessions.requestHandoff. Through tools.invoke it also belongs to that client; client revocation or cancellation before result acceptance closes it. Pending and live connections share a limit of 8 per plugin and 64 total; connection setup has a 120-second deadline. Opening a terminal or file tab does not transfer ownership. User-created connections are unaffected."),
    method!("sessions.disconnect", ["ssh.exec"], "{sessionId:string}", "Disconnect an active SSH session."),
    method!("sessions.requestHandoff", ["ssh.exec"], "{sessionId:string}", "Ask the user in a native dialog to keep this runtime's live SSH connection independently of plugin/client lifetime. Returns true only after accepted ownership transfer, false on decline; expired, revoked, disconnected, foreign and pending-result resources fail. Does not open a tab, grant new access or persist the transport across application exit. Not available through tools.invoke."),
    method!("sessions.exec", ["ssh.exec"], "{sessionId:string,command:string,timeoutMs?:number}", "Execute in a separate SSH channel; return stdout/stderr/exitCode/signal. Timeout 100–60000ms, output at most 1MiB."),
];
