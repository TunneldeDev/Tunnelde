use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};

use super::session::ClientHandler;
use crate::{
    error::{AppError, AppResult},
    state::AppState,
};
use russh::{
    client::{self, ChannelOpenHandle},
    Channel,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use tokio::{
    io::{copy_bidirectional, AsyncRead, AsyncWrite},
    net::{TcpListener, TcpStream},
    sync::watch,
};

const TIMEOUT: Duration = Duration::from_secs(15);
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ForwardRule {
    pub id: String,
    pub host_id: String,
    pub name: String,
    pub mode: String,
    pub bind_host: String,
    pub bind_port: u16,
    pub target_host: String,
    pub target_port: u16,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForwardInfo {
    #[serde(flatten)]
    pub rule: ForwardRule,
    pub session_id: Option<String>,
    pub active: bool,
}
#[derive(Clone)]
struct RemoteTarget {
    host: String,
    port: u16,
    cancel: watch::Receiver<bool>,
}
#[derive(Default)]
pub struct RemoteRoutes {
    entries: Mutex<HashMap<(String, u16), RemoteTarget>>,
}
impl RemoteRoutes {
    fn target(&self, address: &str, port: u16) -> Option<RemoteTarget> {
        let entries = self.entries.lock().ok()?;
        if let Some(target) = entries.get(&(address.to_owned(), port)) {
            return Some(target.clone());
        }
        let loopback = |s: &str| matches!(s, "localhost" | "127.0.0.1" | "::1");
        let mut matching = entries.iter().filter(|((host, bound), _)| {
            *bound == port
                && (matches!(host.as_str(), "0.0.0.0" | "::" | "*")
                    || loopback(host) && loopback(address))
        });
        let first = matching.next()?.1.clone();
        if matching.next().is_some() {
            None
        } else {
            Some(first)
        }
    }
}
async fn relay<A, B>(mut first: A, mut second: B, mut cancel: watch::Receiver<bool>)
where
    A: AsyncRead + AsyncWrite + Unpin,
    B: AsyncRead + AsyncWrite + Unpin,
{
    if *cancel.borrow() {
        return;
    }
    tokio::select! { _ = cancel.changed() => {}, _ = copy_bidirectional(&mut first, &mut second) => {} }
}
type RemoteForward = (
    Arc<client::Handle<ClientHandler>>,
    Arc<RemoteRoutes>,
    String,
    u16,
);

struct ActiveForward {
    session: String,
    owner: Option<String>,
    generation: Option<u64>,
    cancel: watch::Sender<bool>,
    remote: Option<RemoteForward>,
}
impl Drop for ActiveForward {
    fn drop(&mut self) {
        let _ = self.cancel.send(true);
        if let Some((handle, routes, host, port)) = self.remote.take() {
            if let Ok(mut entries) = routes.entries.lock() {
                entries.remove(&(host.clone(), port));
            }
            tauri::async_runtime::spawn(async move {
                let _ =
                    tokio::time::timeout(TIMEOUT, handle.cancel_tcpip_forward(host, port as u32))
                        .await;
            });
        }
    }
}
pub struct ForwardRegistry {
    active: Mutex<HashMap<String, ActiveForward>>,
    revisions: Mutex<HashMap<String, u64>>,
    changed: watch::Sender<u64>,
}
impl Default for ForwardRegistry {
    fn default() -> Self {
        Self {
            active: Mutex::new(HashMap::new()),
            revisions: Mutex::new(HashMap::new()),
            changed: watch::channel(0).0,
        }
    }
}
impl ForwardRegistry {
    fn invalidate(&self, key: String) {
        if let Ok(mut revisions) = self.revisions.lock() {
            *revisions.entry(key).or_default() += 1;
        }
        self.changed
            .send_modify(|revision| *revision = revision.wrapping_add(1));
    }
    fn ticket(&self, id: &str, session: &str) -> AppResult<Vec<(String, u64)>> {
        let revisions = self
            .revisions
            .lock()
            .map_err(|_| AppError::internal("forward.lock"))?;
        let keys = vec![
            String::new(),
            format!("rule:{id}"),
            format!("session:{session}"),
        ];
        Ok(keys
            .into_iter()
            .map(|key| {
                let value = *revisions.get(&key).unwrap_or(&0);
                (key, value)
            })
            .collect())
    }
    fn valid_ticket(&self, ticket: &[(String, u64)]) -> bool {
        self.revisions
            .lock()
            .map(|revisions| {
                ticket
                    .iter()
                    .all(|(key, value)| revisions.get(key).unwrap_or(&0) == value)
            })
            .unwrap_or(false)
    }
    pub fn stop(&self, id: &str) {
        if let Ok(mut m) = self.active.lock() {
            self.invalidate(format!("rule:{id}"));
            m.remove(id);
        }
    }
    pub fn stop_session(&self, session: &str) {
        if let Ok(mut m) = self.active.lock() {
            self.invalidate(format!("session:{session}"));
            m.retain(|_, item| item.session != session);
        }
    }
    pub fn stop_generation(&self, owner: &str, generation: u64) {
        if let Ok(mut active) = self.active.lock() {
            active.retain(|_, item| {
                item.owner.as_deref() != Some(owner) || item.generation != Some(generation)
            });
        }
    }
    pub fn stop_before_generation(&self, owner: &str, boundary: u64) {
        if let Ok(mut active) = self.active.lock() {
            active.retain(|_, item| {
                item.owner.as_deref() != Some(owner)
                    || item
                        .generation
                        .is_none_or(|generation| generation >= boundary)
            });
        }
    }
    pub fn stop_all(&self) {
        if let Ok(mut m) = self.active.lock() {
            self.invalidate(String::new());
            m.clear();
        }
    }
}

pub async fn remote_channel(
    routes: &Arc<RemoteRoutes>,
    channel: Channel<client::Msg>,
    connected_address: &str,
    connected_port: u32,
    reply: ChannelOpenHandle,
) {
    let target = u16::try_from(connected_port)
        .ok()
        .and_then(|port| routes.target(connected_address, port));
    let Some(mut target) = target else {
        return;
    };
    if *target.cancel.borrow() {
        return;
    }
    // Never await socket I/O inside russh's handler: its event loop also services SSH traffic.
    tokio::spawn(async move {
        let local = tokio::select! {
            _ = target.cancel.changed() => return,
            result = tokio::time::timeout(TIMEOUT, TcpStream::connect((target.host.as_str(), target.port))) => match result { Ok(Ok(s)) => s, _ => return },
        };
        if *target.cancel.borrow() {
            return;
        }
        reply.accept().await;
        relay(local, channel.into_stream(), target.cancel).await;
    });
}
fn validate(rule: &ForwardRule) -> AppResult<()> {
    let host_valid = |s: &str| {
        !s.is_empty()
            && s.len() <= 253
            && !s
                .chars()
                .any(|c| c.is_whitespace() || c.is_control() || "/\\@?#[]".contains(c))
    };
    if !["local", "remote"].contains(&rule.mode.as_str())
        || rule.id.len() > 128
        || rule.host_id.is_empty()
        || rule.name.trim().is_empty()
        || rule.name.len() > 120
        || rule.bind_port == 0
        || rule.target_port == 0
        || !host_valid(&rule.bind_host)
        || !host_valid(&rule.target_host)
    {
        return Err(AppError::validation("forward.invalid"));
    }
    Ok(())
}
fn key(id: &str) -> String {
    format!("forward:{id}")
}
fn rules(app: &AppHandle) -> AppResult<Vec<ForwardRule>> {
    app.state::<AppState>().db.with(|conn| {
        let mut stmt = conn.prepare(
            "SELECT value FROM settings WHERE key LIKE 'forward:%' ORDER BY updated_at DESC",
        )?;
        let raw = stmt.query_map([], |row| row.get::<_, String>(0))?;
        let mut result = Vec::new();
        for item in raw {
            result.push(serde_json::from_str(&item?)?);
        }
        Ok(result)
    })
}
pub fn list(app: &AppHandle) -> AppResult<Vec<ForwardInfo>> {
    let rules = rules(app)?;
    let state = app.state::<AppState>();
    let active = state
        .forwards
        .active
        .lock()
        .map_err(|_| AppError::internal("forward.lock"))?;
    Ok(rules
        .into_iter()
        .map(|rule| {
            let session_id = active.get(&rule.id).map(|item| item.session.clone());
            ForwardInfo {
                active: session_id.is_some(),
                session_id,
                rule,
            }
        })
        .collect())
}
pub fn save(app: &AppHandle, mut rule: ForwardRule) -> AppResult<ForwardRule> {
    if rule.id.is_empty() {
        rule.id = uuid::Uuid::new_v4().to_string();
    }
    validate(&rule)?;
    let state = app.state::<AppState>();
    let active = state
        .forwards
        .active
        .lock()
        .map_err(|_| AppError::internal("forward.lock"))?;
    if active.contains_key(&rule.id) {
        return Err(AppError::validation("forward.stopBeforeEdit"));
    }
    let saved = state.db.with(|conn| {
        crate::db::hosts::find_host(conn, &rule.host_id)?;
        conn.execute("INSERT INTO settings(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at", rusqlite::params![key(&rule.id), serde_json::to_string(&rule)?, crate::models::now_ms()])?;
        Ok(rule.clone())
    })?;
    state.forwards.invalidate(format!("rule:{}", rule.id));
    Ok(saved)
}
pub fn remove(app: &AppHandle, id: &str) -> AppResult<()> {
    let state = app.state::<AppState>();
    let mut active = state
        .forwards
        .active
        .lock()
        .map_err(|_| AppError::internal("forward.lock"))?;
    state.db.with(|conn| {
        conn.execute("DELETE FROM settings WHERE key=?1", [key(id)])?;
        Ok(())
    })?;
    state.forwards.invalidate(format!("rule:{id}"));
    active.remove(id);
    Ok(())
}
pub async fn start(app: &AppHandle, id: &str, session_id: &str) -> AppResult<()> {
    start_owned(app, id, session_id, None).await
}
pub async fn start_owned(
    app: &AppHandle,
    id: &str,
    session_id: &str,
    owner: Option<(String, u64)>,
) -> AppResult<()> {
    let state = app.state::<AppState>();
    let mut changed = state.forwards.changed.subscribe();
    let ticket = state.forwards.ticket(id, session_id)?;
    let rule = rules(app)?
        .into_iter()
        .find(|r| r.id == id)
        .ok_or_else(|| AppError::validation("forward.missing"))?;
    validate(&rule)?;
    if !state
        .ssh
        .list()
        .iter()
        .any(|s| s.id == session_id && s.host_id == rule.host_id)
    {
        return Err(AppError::validation("ssh.sessionMissing"));
    }
    if state
        .forwards
        .active
        .lock()
        .map_err(|_| AppError::internal("forward.lock"))?
        .contains_key(id)
    {
        return Err(AppError::validation("forward.alreadyActive"));
    }
    let handle = state.ssh.handle(session_id)?;
    let setup = open_forward(
        handle,
        state.ssh.remote_routes(session_id)?,
        &rule,
        session_id,
        owner,
    );
    tokio::pin!(setup);
    let item = loop {
        tokio::select! {
            result = &mut setup => break result?,
            _ = changed.changed() => {
                if !state.forwards.valid_ticket(&ticket) { return Err(AppError::validation("forward.startCancelled")); }
            }
        }
    };
    // If the session closed during setup, dropping the item cancels all created resources.
    let mut active = state
        .forwards
        .active
        .lock()
        .map_err(|_| AppError::internal("forward.lock"))?;
    if !state.forwards.valid_ticket(&ticket) {
        return Err(AppError::validation("forward.startCancelled"));
    }
    if !state.ssh.list().iter().any(|s| s.id == session_id) {
        return Err(AppError::validation("ssh.sessionMissing"));
    }
    if !rules(app)?.iter().any(|saved| saved == &rule) {
        return Err(AppError::validation("forward.missing"));
    }
    if active.contains_key(id) {
        return Err(AppError::validation("forward.alreadyActive"));
    }
    active.insert(id.to_owned(), item);
    Ok(())
}

#[tauri::command]
pub fn forwarding_list(app: AppHandle) -> AppResult<Vec<ForwardInfo>> {
    list(&app)
}
#[tauri::command]
pub fn forwarding_save(app: AppHandle, rule: ForwardRule) -> AppResult<ForwardRule> {
    save(&app, rule)
}
#[tauri::command]
pub fn forwarding_remove(app: AppHandle, id: String) -> AppResult<()> {
    remove(&app, &id)
}
#[tauri::command]
pub async fn forwarding_start(app: AppHandle, id: String, session_id: String) -> AppResult<()> {
    start(&app, &id, &session_id).await
}
#[tauri::command]
pub fn forwarding_stop(app: AppHandle, id: String) {
    app.state::<AppState>().forwards.stop(&id);
}

#[cfg(test)]
mod tests {
    use super::*;
    fn rule() -> ForwardRule {
        ForwardRule {
            id: "a".into(),
            host_id: "h".into(),
            name: "Database".into(),
            mode: "local".into(),
            bind_host: "127.0.0.1".into(),
            bind_port: 5433,
            target_host: "127.0.0.1".into(),
            target_port: 5432,
        }
    }
    #[test]
    fn validates_endpoints() {
        let mut r = rule();
        assert!(validate(&r).is_ok());
        r.target_host = "x\r\ninvalid".into();
        assert!(validate(&r).is_err());
        r.target_host = "::1".into();
        assert!(validate(&r).is_ok());
        r.bind_port = 0;
        assert!(validate(&r).is_err());
    }
    #[tokio::test]
    async fn stopping_session_signals_all_connections() {
        let reg = ForwardRegistry::default();
        let (tx, mut rx) = watch::channel(false);
        reg.active.lock().unwrap().insert(
            "rule".into(),
            ActiveForward {
                session: "session".into(),
                owner: None,
                generation: None,
                cancel: tx,
                remote: None,
            },
        );
        reg.stop_session("other");
        assert!(!*rx.borrow());
        reg.stop_session("session");
        rx.changed().await.unwrap();
        assert!(*rx.borrow());
    }
}
async fn open_forward(
    handle: Arc<client::Handle<ClientHandler>>,
    routes: Arc<RemoteRoutes>,
    rule: &ForwardRule,
    session_id: &str,
    owner: Option<(String, u64)>,
) -> AppResult<ActiveForward> {
    let (owner, generation) = owner
        .map(|(id, generation)| (Some(id), Some(generation)))
        .unwrap_or_default();
    let (cancel, mut cancelled) = watch::channel(false);
    let remote = if rule.mode == "local" {
        let listener = TcpListener::bind((rule.bind_host.as_str(), rule.bind_port))
            .await
            .map_err(|_| AppError::validation("forward.bindFailed"))?;
        let h = handle.clone();
        let host = rule.target_host.clone();
        let port = rule.target_port;
        tokio::spawn(async move {
            loop {
                let accepted = tokio::select! { _ = cancelled.changed() => break, result = listener.accept() => result };
                let Ok((socket, origin)) = accepted else {
                    break;
                };
                let h = h.clone();
                let host = host.clone();
                let mut c = cancelled.clone();
                tokio::spawn(async move {
                    let channel = tokio::select! {
                        _ = c.changed() => return,
                        result = tokio::time::timeout(TIMEOUT, h.channel_open_direct_tcpip(host, port as u32, origin.ip().to_string(), origin.port() as u32)) => match result { Ok(Ok(ch)) => ch, _ => return },
                    };
                    relay(socket, channel.into_stream(), c).await;
                });
            }
        });
        None
    } else {
        {
            let mut entries = routes
                .entries
                .lock()
                .map_err(|_| AppError::internal("forward.lock"))?;
            let key = (rule.bind_host.clone(), rule.bind_port);
            if entries.contains_key(&key) {
                return Err(AppError::validation("forward.bindFailed"));
            }
            entries.insert(
                key,
                RemoteTarget {
                    host: rule.target_host.clone(),
                    port: rule.target_port,
                    cancel: cancelled,
                },
            );
        }
        // Own cleanup before awaiting the request. Dropping an in-flight setup
        // must revoke the route and cancel a listener the server may yet accept.
        let pending = ActiveForward {
            session: session_id.to_owned(),
            owner,
            generation,
            cancel,
            remote: Some((
                handle.clone(),
                routes,
                rule.bind_host.clone(),
                rule.bind_port,
            )),
        };
        let requested = tokio::time::timeout(
            TIMEOUT,
            handle.tcpip_forward(rule.bind_host.clone(), rule.bind_port as u32),
        )
        .await;
        if !matches!(requested, Ok(Ok(_))) {
            return Err(AppError::validation("forward.remoteRejected"));
        }
        return Ok(pending);
    };
    Ok(ActiveForward {
        session: session_id.to_owned(),
        owner,
        generation,
        cancel,
        remote,
    })
}
#[cfg(test)]
#[path = "forward_tests.rs"]
mod protocol_tests;
