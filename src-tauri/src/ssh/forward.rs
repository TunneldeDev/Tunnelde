use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

use super::session::ClientHandler;
use crate::error::{AppError, AppResult};
use crate::services::forwarding::contract::ForwardRule;
use russh::{
    client::{self, ChannelOpenHandle},
    Channel,
};
use tokio::{
    io::{copy_bidirectional, AsyncRead, AsyncWrite},
    net::{TcpListener, TcpStream},
    sync::watch,
};

const TIMEOUT: Duration = Duration::from_secs(15);
#[derive(Clone)]
struct RemoteTarget {
    admitted: Arc<AtomicBool>,
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

async fn release_remote((handle, routes, host, port): RemoteForward) -> AppResult<()> {
    tokio::time::timeout(
        TIMEOUT,
        handle.cancel_tcpip_forward(host.clone(), port as u32),
    )
    .await
    .map_err(|_| AppError::Ssh("forward.stopFailed".into()))?
    .map_err(|_| AppError::Ssh("forward.stopFailed".into()))?;
    if let Ok(mut entries) = routes.entries.lock() {
        entries.remove(&(host, port));
    }
    Ok(())
}

struct ActiveForward {
    admitted: Arc<AtomicBool>,
    identity: String,
    session: String,
    owner: Option<String>,
    generation: Option<u64>,
    cancel: watch::Sender<bool>,
    listener: Option<tokio::task::JoinHandle<()>>,
    remote: Option<RemoteForward>,
}
impl ActiveForward {
    async fn shutdown(mut self) -> AppResult<()> {
        let _ = self.cancel.send(true);
        if let Some(listener) = self.listener.take() {
            listener.abort();
            // The join completes only after the local socket has been dropped.
            let _ = listener.await;
        }
        if let Some(remote) = self.remote.take() {
            release_remote(remote).await?;
        }
        Ok(())
    }
}
impl Drop for ActiveForward {
    fn drop(&mut self) {
        let _ = self.cancel.send(true);
        if let Some(listener) = self.listener.take() {
            listener.abort();
        }
        if let Some(remote) = self.remote.take() {
            // Reserve the endpoint until the cancellation request completes.
            // A new forward must never overtake an older detached cleanup.
            let completion = self.cancel.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(error) = release_remote(remote).await {
                    tracing::warn!(%error, "Could not release remote forwarding listener");
                }
                drop(completion);
            });
        }
    }
}
pub struct ForwardRegistry {
    active: Mutex<HashMap<String, ActiveForward>>,
    revisions: Mutex<HashMap<String, u64>>,
    changed: watch::Sender<u64>,
    notify: Option<Arc<dyn Fn() + Send + Sync>>,
}
impl Default for ForwardRegistry {
    fn default() -> Self {
        Self {
            active: Mutex::new(HashMap::new()),
            revisions: Mutex::new(HashMap::new()),
            changed: watch::channel(0).0,
            notify: None,
        }
    }
}
impl ForwardRegistry {
    pub(crate) fn with_notifier(notify: impl Fn() + Send + Sync + 'static) -> Self {
        Self {
            notify: Some(Arc::new(notify)),
            ..Default::default()
        }
    }
    fn publish(&self) {
        if let Some(notify) = &self.notify {
            notify();
        }
    }
    pub(crate) fn snapshot(&self) -> AppResult<HashMap<String, (String, String)>> {
        Ok(self
            .active
            .lock()
            .map_err(|_| AppError::internal("forward.lock"))?
            .iter()
            .map(|(id, item)| (id.clone(), (item.session.clone(), item.identity.clone())))
            .collect())
    }
    /// Serialize persistence with listener admission, then notify outside both locks.
    pub(crate) fn edit<T>(&self, id: &str, commit: impl FnOnce() -> AppResult<T>) -> AppResult<T> {
        let active = self
            .active
            .lock()
            .map_err(|_| AppError::internal("forward.lock"))?;
        if active.contains_key(id) {
            return Err(AppError::validation("forward.stopBeforeEdit"));
        }
        let result = commit()?;
        self.invalidate(format!("rule:{id}"));
        drop(active);
        self.publish();
        Ok(result)
    }
    pub(crate) fn remove_rule(
        &self,
        id: &str,
        commit: impl FnOnce() -> AppResult<bool>,
    ) -> AppResult<()> {
        let mut active = self
            .active
            .lock()
            .map_err(|_| AppError::internal("forward.lock"))?;
        let changed = commit()?;
        self.invalidate(format!("rule:{id}"));
        let removed = active.remove(id);
        drop(active);
        let notify = changed || removed.is_some();
        drop(removed);
        if notify {
            self.publish();
        }
        Ok(())
    }
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
    pub(crate) fn take_checked(
        &self,
        id: &str,
        expected: Option<&str>,
        check: impl FnOnce() -> AppResult<()>,
    ) -> AppResult<StoppedForward> {
        let mut active = self
            .active
            .lock()
            .map_err(|_| AppError::internal("forward.lock"))?;
        check()?;
        if expected
            .is_some_and(|expected| active.get(id).is_none_or(|item| item.identity != expected))
        {
            return Err(AppError::validation("forward.changed"));
        }
        self.invalidate(format!("rule:{id}"));
        let item = active.remove(id);
        drop(active);
        if item.is_some() {
            self.publish();
        }
        // Spawn before returning so caller cancellation cannot interrupt cleanup.
        Ok(StoppedForward(
            item.map(|item| tauri::async_runtime::spawn(item.shutdown())),
        ))
    }
    pub async fn stop(&self, id: &str) -> AppResult<()> {
        self.take_checked(id, None, || Ok(()))?.finish().await
    }
    pub fn stop_session(&self, session: &str) {
        if let Ok(mut m) = self.active.lock() {
            self.invalidate(format!("session:{session}"));
            let previous = m.len();
            m.retain(|_, item| item.session != session);
            let changed = m.len() != previous;
            drop(m);
            if changed {
                self.publish();
            }
        }
    }
    pub fn stop_generation(&self, owner: &str, generation: u64) {
        if let Ok(mut active) = self.active.lock() {
            let previous = active.len();
            active.retain(|_, item| {
                item.owner.as_deref() != Some(owner) || item.generation != Some(generation)
            });
            let changed = active.len() != previous;
            drop(active);
            if changed {
                self.publish();
            }
        }
    }
    pub fn stop_before_generation(&self, owner: &str, boundary: u64) {
        if let Ok(mut active) = self.active.lock() {
            let previous = active.len();
            active.retain(|_, item| {
                item.owner.as_deref() != Some(owner)
                    || item
                        .generation
                        .is_none_or(|generation| generation >= boundary)
            });
            let changed = active.len() != previous;
            drop(active);
            if changed {
                self.publish();
            }
        }
    }
    pub fn stop_all(&self) {
        if let Ok(mut m) = self.active.lock() {
            self.invalidate(String::new());
            let changed = !m.is_empty();
            m.clear();
            drop(m);
            if changed {
                self.publish();
            }
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
    if !target.admitted.load(Ordering::Acquire) || *target.cancel.borrow() {
        return;
    }
    // Never await socket I/O inside russh's handler: its event loop also services SSH traffic.
    tokio::spawn(async move {
        let local = tokio::select! {
            _ = target.cancel.changed() => return,
            result = tokio::time::timeout(TIMEOUT, TcpStream::connect((target.host.as_str(), target.port))) => match result { Ok(Ok(s)) => s, _ => return },
        };
        if !target.admitted.load(Ordering::Acquire) || *target.cancel.borrow() {
            return;
        }
        reply.accept().await;
        relay(local, channel.into_stream(), target.cancel).await;
    });
}
/// A prepared listener owns its cleanup until committed to the registry.
pub(crate) struct PendingForward {
    id: String,
    ticket: Vec<(String, u64)>,
    item: ActiveForward,
}
impl PendingForward {
    /// Callers can hold their authorization/scope locks before acquiring the registry.
    pub(crate) fn commit(
        self,
        registry: &ForwardRegistry,
        current: impl FnOnce() -> AppResult<()>,
    ) -> AppResult<()> {
        let mut active = registry
            .active
            .lock()
            .map_err(|_| AppError::internal("forward.lock"))?;
        if !registry.valid_ticket(&self.ticket) {
            return Err(AppError::validation("forward.startCancelled"));
        }
        current()?;
        if active.contains_key(&self.id) {
            return Err(AppError::validation("forward.alreadyActive"));
        }
        self.item.admitted.store(true, Ordering::Release);
        active.insert(self.id, self.item);
        drop(active);
        registry.publish();
        Ok(())
    }
}

pub(crate) struct StoppedForward(Option<tauri::async_runtime::JoinHandle<AppResult<()>>>);
impl StoppedForward {
    pub(crate) async fn finish(self) -> AppResult<()> {
        if let Some(task) = self.0 {
            task.await
                .map_err(|_| AppError::internal("forward.stopFailed"))??;
        }
        Ok(())
    }
}

pub(crate) async fn prepare(
    registry: &ForwardRegistry,
    rule: &ForwardRule,
    session_id: &str,
    handle: Arc<client::Handle<ClientHandler>>,
    routes: Arc<RemoteRoutes>,
    owner: Option<(String, u64)>,
) -> AppResult<PendingForward> {
    let id = &rule.id;
    let mut changed = registry.changed.subscribe();
    let ticket = registry.ticket(id, session_id)?;
    if registry
        .active
        .lock()
        .map_err(|_| AppError::internal("forward.lock"))?
        .contains_key(id)
    {
        return Err(AppError::validation("forward.alreadyActive"));
    }
    let setup = open_uncommitted_forward(handle, routes, rule, session_id, owner, false);
    tokio::pin!(setup);
    let item = loop {
        tokio::select! {
            result = &mut setup => break result?,
            _ = changed.changed() => {
                if !registry.valid_ticket(&ticket) { return Err(AppError::validation("forward.startCancelled")); }
            }
        }
    };
    Ok(PendingForward {
        id: id.clone(),
        ticket,
        item,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::forwarding::contract::validate;
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
                admitted: Arc::new(AtomicBool::new(true)),
                identity: uuid::Uuid::new_v4().to_string(),
                session: "session".into(),
                owner: None,
                generation: None,
                cancel: tx,
                listener: None,
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
#[cfg(test)]
async fn open_forward(
    handle: Arc<client::Handle<ClientHandler>>,
    routes: Arc<RemoteRoutes>,
    rule: &ForwardRule,
    session_id: &str,
    owner: Option<(String, u64)>,
) -> AppResult<ActiveForward> {
    open_uncommitted_forward(handle, routes, rule, session_id, owner, true).await
}
async fn open_uncommitted_forward(
    handle: Arc<client::Handle<ClientHandler>>,
    routes: Arc<RemoteRoutes>,
    rule: &ForwardRule,
    session_id: &str,
    owner: Option<(String, u64)>,
    published: bool,
) -> AppResult<ActiveForward> {
    let admitted = Arc::new(AtomicBool::new(published));
    let (owner, generation) = owner
        .map(|(id, generation)| (Some(id), Some(generation)))
        .unwrap_or_default();
    let (cancel, mut cancelled) = watch::channel(false);
    let listener = if rule.mode == "local" {
        let listener = TcpListener::bind((rule.bind_host.as_str(), rule.bind_port))
            .await
            .map_err(|_| AppError::validation("forward.bindFailed"))?;
        let allowed = admitted.clone();
        let h = handle.clone();
        let host = rule.target_host.clone();
        let port = rule.target_port;
        Some(tokio::spawn(async move {
            loop {
                let accepted = tokio::select! { _ = cancelled.changed() => break, result = listener.accept() => result };
                let Ok((socket, origin)) = accepted else {
                    break;
                };
                if !allowed.load(Ordering::Acquire) {
                    continue;
                }
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
        }))
    } else {
        loop {
            let stopping = {
                let mut entries = routes
                    .entries
                    .lock()
                    .map_err(|_| AppError::internal("forward.lock"))?;
                let key = (rule.bind_host.clone(), rule.bind_port);
                if let Some(previous) = entries.get(&key) {
                    if !*previous.cancel.borrow() {
                        return Err(AppError::validation("forward.bindFailed"));
                    }
                    if previous.cancel.has_changed().is_err() {
                        // Failed/uncertain cleanup requires a new SSH connection;
                        // its late cancellation must not close a newer listener.
                        return Err(AppError::Ssh("forward.stopFailed".into()));
                    }
                    Some(previous.cancel.clone())
                } else {
                    entries.insert(
                        key,
                        RemoteTarget {
                            admitted: admitted.clone(),
                            host: rule.target_host.clone(),
                            port: rule.target_port,
                            cancel: cancelled.clone(),
                        },
                    );
                    None
                }
            };
            let Some(mut stopping) = stopping else { break };
            // A cleanup task retains the sender until it has removed the old
            // route. Waiting for channel closure avoids polling and lost wakes.
            tokio::time::timeout(TIMEOUT, async { while stopping.changed().await.is_ok() {} })
                .await
                .map_err(|_| AppError::Ssh("forward.stopFailed".into()))?;
        }
        // Own cleanup before awaiting the request. Dropping an in-flight setup
        // must revoke the route and cancel a listener the server may yet accept.
        let pending = ActiveForward {
            admitted,
            identity: uuid::Uuid::new_v4().to_string(),
            session: session_id.to_owned(),
            owner,
            generation,
            cancel,
            listener: None,
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
        admitted,
        identity: uuid::Uuid::new_v4().to_string(),
        session: session_id.to_owned(),
        owner,
        generation,
        cancel,
        listener,
        remote: None,
    })
}
#[cfg(test)]
#[path = "forward_tests.rs"]
mod protocol_tests;

#[cfg(test)]
#[path = "forward_registry_tests.rs"]
mod registry_tests;
