use super::*;
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Session {
    id: String,
    host_id: String,
    title: String,
    address: String,
    connected_at: i64,
    terminal: bool,
}
pub(super) fn project(sessions: Vec<crate::ssh::SessionInfo>) -> Value {
    let sessions: Vec<_> = sessions
        .into_iter()
        .map(|session| Session {
            id: session.id,
            host_id: session.host_id,
            title: session.title,
            address: session.address,
            connected_at: session.connected_at,
            terminal: session.terminal,
        })
        .collect();
    json!({"sessions": sessions})
}
