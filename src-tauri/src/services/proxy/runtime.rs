//! Proxy-group lifecycle. One SSH transport per active group, all local
//! listeners and live connections fenced by an epoch token.
use super::{
    contract::{
        MissPolicy, ProxyConnection, ProxyGroup, ProxyRoute, ProxyRuntime, RevisionedGroup,
        RevisionedRoute, RouteMode, TunAttach,
    },
    repository,
    socks::{self, Decision, Destination},
};
use crate::{
    error::{AppError, AppResult},
    models::now_ms,
    ssh::SshConnectRequest,
    state::AppState,
};
use std::{
    collections::HashMap,
    net::SocketAddr,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex, RwLock,
    },
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::{watch, Semaphore},
};

const TIMEOUT: Duration = Duration::from_secs(15);
const RELAY_IDLE: Duration = Duration::from_secs(300);

#[derive(Clone, Debug)]
struct Snapshot {
    group: RevisionedGroup,
    routes: Vec<RevisionedRoute>,
}

struct LiveConnection {
    group_id: String,
    route_id: Option<String>,
    source: String,
    target: String,
    bytes_up: Arc<AtomicU64>,
    bytes_down: Arc<AtomicU64>,
    started_at: i64,
    cancel: watch::Sender<bool>,
    status: Arc<Mutex<(String, Option<String>)>>,
}

/// Connections reserve capacity before handshaking and remain visible while a
/// direct miss is connecting, so stop/close can fence every accepted socket.
struct PendingConnection {
    group_id: String,
    source: String,
    started_at: i64,
    cancel: watch::Sender<bool>,
    status: Arc<Mutex<(String, Option<String>)>>,
}

struct Active {
    owner: Option<(String, u64)>,
    group: ProxyGroup,
    revision: String,
    session_id: String,
    endpoint: String,
    started_at: i64,
    cancel: watch::Sender<bool>,
    pending: Arc<Mutex<HashMap<String, PendingConnection>>>,
    connections: Arc<Mutex<HashMap<String, LiveConnection>>>,
    listeners: Vec<tokio::task::JoinHandle<()>>,
    attach_auth: Arc<RwLock<Option<(String, String)>>>,
}

#[derive(Default)]
pub struct Registry {
    active: Mutex<HashMap<String, Active>>,
    paused: Mutex<std::collections::HashSet<String>>,
}

impl Registry {
    pub(crate) fn is_active(&self, group_id: &str) -> bool {
        self.active
            .lock()
            .is_ok_and(|entries| entries.contains_key(group_id))
    }
    pub(crate) fn is_paused(&self, group_id: &str) -> bool {
        self.paused
            .lock()
            .is_ok_and(|entries| entries.contains(group_id))
    }
    fn resume(&self, group_id: &str) {
        if let Ok(mut paused) = self.paused.lock() {
            paused.remove(group_id);
        }
    }
    fn pause(&self, group_id: &str) {
        if let Ok(mut paused) = self.paused.lock() {
            paused.insert(group_id.to_owned());
        }
    }
}

fn publish(app: &AppHandle) {
    let _ = app.emit(
        "plugin://domain-changed",
        serde_json::json!({"domain":"proxy"}),
    );
}

fn endpoint(host: &str, port: u16) -> String {
    if host.contains(':') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    }
}

fn source(addr: SocketAddr) -> String {
    if addr.ip().is_ipv6() {
        format!("[{}]:{}", addr.ip(), addr.port())
    } else {
        addr.to_string()
    }
}

fn remove_pending(pending: &Mutex<HashMap<String, PendingConnection>>, id: &str) {
    if let Ok(mut entries) = pending.lock() {
        entries.remove(id);
    }
}

fn close_pending(pending: &Mutex<HashMap<String, PendingConnection>>, id: &str) -> bool {
    pending
        .lock()
        .ok()
        .and_then(|entries| entries.get(id).map(|entry| entry.cancel.clone()))
        .is_some_and(|cancel| cancel.send(true).is_ok())
}

fn snapshot(app: &AppHandle, group_id: Option<&str>) -> AppResult<Vec<Snapshot>> {
    let state = app.state::<AppState>();
    state.db.with(|conn| {
        let groups = repository::list_groups_conn(conn)?;
        let routes = repository::list_routes_conn(conn)?;
        Ok(groups
            .into_iter()
            .filter(|entry| group_id.is_none_or(|id| entry.group.id == id))
            .map(|group| Snapshot {
                routes: routes
                    .iter()
                    .filter(|route| route.route.group_id == group.group.id)
                    .cloned()
                    .collect(),
                group,
            })
            .collect())
    })
}

fn request(host_id: &str) -> SshConnectRequest {
    SshConnectRequest {
        host_id: host_id.into(),
        background: true,
        purpose: Some("proxy".into()),
        password: None,
        passphrase: None,
        jump_credentials: HashMap::new(),
        cols: 80,
        rows: 24,
    }
}

fn verify(
    group: &ProxyGroup,
    attach: &RwLock<Option<(String, String)>>,
    username: &str,
    password: &str,
) -> bool {
    if attach.read().ok().is_some_and(|value| {
        value
            .as_ref()
            .is_some_and(|(user, secret)| user == username && secret == password)
    }) {
        return true;
    }
    let Some(expected) = group.auth_verifier.as_deref() else {
        return false;
    };
    let Some(salt) = group.auth_salt.as_deref() else {
        return false;
    };
    username == group.auth_username
        && repository::password_verifier(username, password, salt) == expected
}

async fn connect_ssh(
    app: &AppHandle,
    group: &ProxyGroup,
) -> AppResult<(
    String,
    Arc<russh::client::Handle<crate::ssh::session::ClientHandler>>,
)> {
    let state = app.state::<AppState>();
    let target = crate::services::credentials::inspect({
        let app = app.clone();
        let host_id = group.host_id.clone();
        move || {
            let host = crate::services::hosts::resolve(&app, &host_id)?;
            crate::ssh::session::review::Target::from_displayed(&app, &host)
        }
    })
    .await?;
    let info = target
        .connect(app.clone(), request(&group.host_id), false, false)
        .await?;
    let handle = state.ssh.handle(&info.id)?;
    state.ssh.publish(&info.id)?;
    crate::ssh::session::announce_connection(app);
    Ok((info.id, handle))
}

async fn open_remote(
    handle: Arc<russh::client::Handle<crate::ssh::session::ClientHandler>>,
    target: &str,
    port: u16,
    origin: SocketAddr,
) -> AppResult<russh::Channel<russh::client::Msg>> {
    tokio::time::timeout(
        TIMEOUT,
        handle.channel_open_direct_tcpip(
            target,
            port as u32,
            origin.ip().to_string(),
            origin.port() as u32,
        ),
    )
    .await
    .map_err(|_| AppError::Ssh("proxy.timeout".into()))?
    .map_err(|_| AppError::Ssh("proxy.directTcpipFailed".into()))
}

async fn relay(
    mut client: TcpStream,
    channel: russh::Channel<russh::client::Msg>,
    up: Arc<AtomicU64>,
    down: Arc<AtomicU64>,
    cancel: watch::Receiver<bool>,
) {
    let (mut reader, mut writer) = client.split();
    let stream = channel.into_stream();
    let (mut ssh_reader, mut ssh_writer) = tokio::io::split(stream);
    let mut cancel_a = cancel.clone();
    let mut cancel_b = cancel;
    let a = async {
        let mut buffer = vec![0_u8; 16 * 1024];
        loop {
            let read = tokio::select! {
                _ = cancel_a.changed() => break,
                result = tokio::time::timeout(RELAY_IDLE, reader.read(&mut buffer)) => match result {
                    Ok(Ok(0)) | Err(_) | Ok(Err(_)) => break,
                    Ok(Ok(read)) => read,
                }
            };
            if ssh_writer.write_all(&buffer[..read]).await.is_err() {
                break;
            }
            up.fetch_add(read as u64, Ordering::Relaxed);
        }
        let _ = ssh_writer.shutdown().await;
    };
    let b = async {
        let mut buffer = vec![0_u8; 16 * 1024];
        loop {
            let read = tokio::select! {
                _ = cancel_b.changed() => break,
                result = tokio::time::timeout(RELAY_IDLE, ssh_reader.read(&mut buffer)) => match result {
                    Ok(Ok(0)) | Err(_) | Ok(Err(_)) => break,
                    Ok(Ok(read)) => read,
                }
            };
            if writer.write_all(&buffer[..read]).await.is_err() {
                break;
            }
            down.fetch_add(read as u64, Ordering::Relaxed);
        }
        let _ = writer.shutdown().await;
    };
    tokio::join!(a, b);
}

async fn serve_connection(
    app: AppHandle,
    group: ProxyGroup,
    routes: Vec<ProxyRoute>,
    handle: Arc<russh::client::Handle<crate::ssh::session::ClientHandler>>,
    mut socket: TcpStream,
    origin: SocketAddr,
    pending: Arc<Mutex<HashMap<String, PendingConnection>>>,
    connections: Arc<Mutex<HashMap<String, LiveConnection>>>,
    _cancel: watch::Receiver<bool>,
    permits: Arc<Semaphore>,
    attach_auth: Arc<RwLock<Option<(String, String)>>>,
    _dedicated: bool,
) {
    let _permit = match permits.try_acquire_owned() {
        Ok(permit) => permit,
        Err(_) => {
            let _ = socket.write_all(&socks::error_reply(0x05)).await;
            return;
        }
    };
    let id = uuid::Uuid::new_v4().to_string();
    let status = Arc::new(Mutex::new(("connecting".to_string(), None)));
    let (close, close_rx) = watch::channel(false);
    let started_at = now_ms();
    let record = PendingConnection {
        group_id: group.id.clone(),
        source: source(origin),
        started_at,
        cancel: close.clone(),
        status: status.clone(),
    };
    if let Ok(mut entries) = pending.lock() {
        entries.insert(id.clone(), record);
    }
    let _pending = PendingGuard {
        id: id.clone(),
        pending: pending.clone(),
    };
    if *close_rx.borrow() {
        return;
    }
    let verify = {
        let group = group.clone();
        let attach_auth = attach_auth.clone();
        move |username: &str, password: &str| verify(&group, &attach_auth, username, password)
    };
    let connect_cancel = _cancel.clone();
    let pending_cancel = close_rx.clone();
    let allow_none = group.auth_mode != "password";
    let (request, _method) = tokio::select! {
        _ = wait_cancel(connect_cancel.clone()) => return,
        _ = wait_cancel(pending_cancel.clone()) => return,
        result = socks::accept(&mut socket, allow_none, Some(&verify)) => {
            match result {
                Ok(request) => request,
                Err(error) => {
                    tracing::debug!(%error, "SOCKS handshake rejected");
                    return;
                }
            }
        }
    };
    if *connect_cancel.borrow() || *pending_cancel.borrow() {
        return;
    }
    let decision = socks::match_route(
        &routes,
        &request.destination,
        request.port,
        group.miss_policy,
    );
    let (route_id, target, port) = match decision {
        Decision::Route(index) => {
            let route = &routes[index];
            let (target, port) = if route.target_host.is_empty() {
                (
                    match &request.destination {
                        Destination::Ip(value) => value.to_string(),
                        Destination::Domain(value) => value.clone(),
                    },
                    request.port,
                )
            } else {
                (route.target_host.clone(), route.target_port)
            };
            (Some(route.id.clone()), target, port)
        }
        Decision::Miss(MissPolicy::Reject) => {
            let _ = socket.write_all(&socks::error_reply(0x02)).await;
            return;
        }
        Decision::Miss(MissPolicy::Direct) => {
            let direct = tokio::time::timeout(TIMEOUT, async {
                tokio::select! {
                    _ = wait_cancel(connect_cancel.clone()) => None,
                    _ = wait_cancel(pending_cancel.clone()) => None,
                    result = TcpStream::connect((target_host(&request.destination), request.port)) => Some(result),
                }
            })
            .await;
            match direct {
                Ok(Some(Ok(mut upstream))) => {
                    if socket.write_all(&socks::success_reply()).await.is_err() {
                        return;
                    }
                    if let Ok(mut status) = status.lock() {
                        status.0 = "running".into();
                    }
                    tokio::select! {
                        _ = wait_cancel(connect_cancel) => {}
                        _ = wait_cancel(pending_cancel) => {}
                        _ = tokio::io::copy_bidirectional(&mut socket, &mut upstream) => {}
                    }
                }
                Ok(None) => return,
                _ => {
                    let _ = socket.write_all(&socks::error_reply(0x05)).await;
                }
            }
            return;
        }
        Decision::Miss(MissPolicy::Remote) => (
            None,
            match &request.destination {
                Destination::Ip(value) => value.to_string(),
                Destination::Domain(value) => value.clone(),
            },
            request.port,
        ),
    };
    let channel = tokio::select! {
        _ = wait_cancel(connect_cancel.clone()) => return,
        _ = wait_cancel(pending_cancel.clone()) => return,
        result = open_remote(handle, &target, port, origin) => match result {
            Ok(channel) => channel,
            Err(_) => {
                let _ = socket.write_all(&socks::error_reply(0x05)).await;
                return;
            }
        }
    };
    if socket.write_all(&socks::success_reply()).await.is_err() {
        return;
    }
    let up = Arc::new(AtomicU64::new(0));
    let down = Arc::new(AtomicU64::new(0));
    if let Ok(mut status) = status.lock() {
        status.0 = "running".into();
    }
    remove_pending(&pending, &id);
    let record = LiveConnection {
        group_id: group.id.clone(),
        route_id,
        source: source(origin),
        target: endpoint(&target, port),
        bytes_up: up.clone(),
        bytes_down: down.clone(),
        started_at,
        cancel: close,
        status: status.clone(),
    };
    if let Ok(mut entries) = connections.lock() {
        entries.insert(id.clone(), record);
    }
    let relay_cancel = close_rx.clone();
    let runtime_cancel = connect_cancel;
    tokio::select! {
        _ = wait_cancel(runtime_cancel) => {}
        _ = wait_cancel(relay_cancel.clone()) => {}
        _ = relay(socket, channel, up, down, close_rx) => {}
    }
    if let Ok(mut entries) = connections.lock() {
        entries.remove(&id);
    }
    if let Ok(mut status) = status.lock() {
        status.0 = "closed".into();
    }
    let _ = &app;
}

struct PendingGuard {
    id: String,
    pending: Arc<Mutex<HashMap<String, PendingConnection>>>,
}

impl Drop for PendingGuard {
    fn drop(&mut self) {
        remove_pending(&self.pending, &self.id);
    }
}

fn target_host(destination: &Destination) -> String {
    match destination {
        Destination::Ip(value) => value.to_string(),
        Destination::Domain(value) => value.clone(),
    }
}

async fn run_listener(
    app: AppHandle,
    group: ProxyGroup,
    routes: Vec<ProxyRoute>,
    handle: Arc<russh::client::Handle<crate::ssh::session::ClientHandler>>,
    listener: TcpListener,
    cancel: watch::Receiver<bool>,
    pending: Arc<Mutex<HashMap<String, PendingConnection>>>,
    connections: Arc<Mutex<HashMap<String, LiveConnection>>>,
    permits: Arc<Semaphore>,
    attach_auth: Arc<RwLock<Option<(String, String)>>>,
    dedicated: bool,
) {
    loop {
        let accepted = tokio::select! {
            _ = wait_cancel(cancel.clone()) => break,
            result = listener.accept() => result,
        };
        let Ok((socket, origin)) = accepted else {
            break;
        };
        let app = app.clone();
        let group = group.clone();
        let routes = routes.clone();
        let handle = handle.clone();
        let pending = pending.clone();
        let connections = connections.clone();
        let child_cancel = cancel.clone();
        let permits = permits.clone();
        let attach_auth = attach_auth.clone();
        tokio::spawn(async move {
            serve_connection(
                app,
                group,
                routes,
                handle,
                socket,
                origin,
                pending,
                connections,
                child_cancel,
                permits,
                attach_auth,
                dedicated,
            )
            .await;
        });
    }
}

async fn wait_cancel(mut cancel: watch::Receiver<bool>) {
    if *cancel.borrow() {
        return;
    }
    let _ = cancel.changed().await;
}

pub async fn start_owned(
    app: &AppHandle,
    group_id: &str,
    expected: Option<&str>,
    owner: Option<(String, u64)>,
) -> AppResult<ProxyRuntime> {
    let state = app.state::<AppState>();
    let snap = snapshot(app, Some(group_id))?
        .into_iter()
        .next()
        .ok_or_else(|| AppError::validation("proxy.groupMissing"))?;
    super::contract::validate_group(&snap.group.group)?;
    if expected.is_some_and(|revision| revision != snap.group.revision) {
        return Err(AppError::validation("proxy.changed"));
    }
    if state.proxy.is_active(group_id) {
        return Err(AppError::validation("proxy.alreadyRunning"));
    }
    state.proxy.resume(group_id);
    let (session_id, handle) = connect_ssh(app, &snap.group.group).await?;
    let latest = snapshot(app, Some(group_id))?
        .into_iter()
        .next()
        .ok_or_else(|| AppError::validation("proxy.groupMissing"))?;
    if latest.group.revision != snap.group.revision {
        let _ = crate::ssh::disconnect(app, &session_id);
        return Err(AppError::validation("proxy.changed"));
    }
    let (cancel, cancel_rx) = watch::channel(false);
    let (listener, permits, listen_port) = {
        let listener =
            match socks::bind(&snap.group.group.listen_host, snap.group.group.listen_port).await {
                Ok(listener) => listener,
                Err(error) => {
                    let _ = crate::ssh::disconnect(app, &session_id);
                    return Err(error);
                }
            };
        let port = listener
            .listener
            .local_addr()
            .map_err(|_| AppError::validation("proxy.bindFailed"))?
            .port();
        (listener.listener, listener.permits, port)
    };
    let connections = Arc::new(Mutex::new(HashMap::new()));
    let pending = Arc::new(Mutex::new(HashMap::new()));
    let attach_auth = Arc::new(RwLock::new(None));
    let shared_permits = permits.clone();
    let routes = snap
        .routes
        .iter()
        .map(|entry| entry.route.clone())
        .collect();
    let mut listeners = vec![tokio::spawn(run_listener(
        app.clone(),
        snap.group.group.clone(),
        routes,
        handle.clone(),
        listener,
        cancel_rx.clone(),
        pending.clone(),
        connections.clone(),
        permits,
        attach_auth.clone(),
        false,
    ))];
    for entry in snap
        .routes
        .iter()
        .filter(|entry| entry.route.mode == RouteMode::Dedicated)
    {
        let route = &entry.route;
        let bind_host = route
            .bind_host
            .clone()
            .ok_or_else(|| AppError::validation("proxy.invalid"))?;
        let bind_port = route
            .bind_port
            .ok_or_else(|| AppError::validation("proxy.invalid"))?;
        let dedicated = match socks::bind(&bind_host, bind_port).await {
            Ok(listener) => listener,
            Err(error) => {
                let _ = cancel.send(true);
                for listener in &listeners {
                    listener.abort();
                }
                let _ = crate::ssh::disconnect(app, &session_id);
                return Err(error);
            }
        };
        listeners.push(tokio::spawn(run_listener(
            app.clone(),
            snap.group.group.clone(),
            vec![route.clone()],
            handle.clone(),
            dedicated.listener,
            cancel_rx.clone(),
            pending.clone(),
            connections.clone(),
            shared_permits.clone(),
            attach_auth.clone(),
            true,
        )));
    }
    let endpoint = endpoint(&snap.group.group.listen_host, listen_port);
    let revision = snap.group.revision.clone();
    let runtime = ProxyRuntime {
        group_id: group_id.into(),
        host_id: snap.group.group.host_id.clone(),
        session_id: session_id.clone(),
        socks_endpoint: endpoint,
        active_connections: 0,
        exposure_warning: snap
            .group
            .group
            .listen_host
            .parse::<std::net::IpAddr>()
            .is_ok_and(|address| !address.is_loopback()),
        started_at: now_ms(),
        revision,
    };
    state
        .proxy
        .active
        .lock()
        .map_err(|_| AppError::internal("proxy.lock"))?
        .insert(
            group_id.into(),
            Active {
                owner,
                group: snap.group.group,
                revision: snap.group.revision,
                session_id,
                endpoint: runtime.socks_endpoint.clone(),
                started_at: runtime.started_at,
                cancel,
                pending,
                connections,
                listeners,
                attach_auth,
            },
        );
    let runtime = ProxyRuntime {
        group_id: runtime.group_id,
        host_id: runtime.host_id,
        session_id: runtime.session_id,
        socks_endpoint: runtime.socks_endpoint,
        active_connections: runtime.active_connections,
        exposure_warning: runtime.exposure_warning,
        started_at: runtime.started_at,
        revision: runtime.revision,
    };
    publish(app);
    Ok(runtime)
}

pub async fn stop(
    app: &AppHandle,
    group_id: &str,
    expected_revision: Option<&str>,
    runtime: Option<&str>,
) -> AppResult<()> {
    let state = app.state::<AppState>();
    let active = {
        let mut entries = state
            .proxy
            .active
            .lock()
            .map_err(|_| AppError::internal("proxy.lock"))?;
        let current = entries
            .get(group_id)
            .ok_or_else(|| AppError::validation("proxy.notRunning"))?;
        if expected_revision.is_some_and(|expected| expected != current.revision)
            || runtime.is_some_and(|expected| expected != current.session_id)
        {
            return Err(AppError::validation("proxy.changed"));
        }
        entries.remove(group_id).expect("validated proxy runtime")
    };
    state.proxy.pause(group_id);
    let _ = active.cancel.send(true);
    if let Ok(mut entries) = active.pending.lock() {
        for connection in entries.values() {
            let _ = connection.cancel.send(true);
        }
        entries.clear();
    }
    if let Ok(mut entries) = active.connections.lock() {
        for connection in entries.values() {
            let _ = connection.cancel.send(true);
        }
        entries.clear();
    }
    for listener in &active.listeners {
        listener.abort();
    }
    for listener in active.listeners {
        let _ = listener.await;
    }
    if let Ok(mut auth) = active.attach_auth.write() {
        *auth = None;
    }
    let transport =
        state
            .ssh
            .take_forwarding_purpose(&active.group.host_id, &active.session_id, "proxy");
    if let Ok(transport) = transport {
        let _ = transport.finish().await;
    }
    publish(app);
    Ok(())
}

pub fn runtime(app: &AppHandle) -> AppResult<Vec<ProxyRuntime>> {
    let state = app.state::<AppState>();
    let entries = state
        .proxy
        .active
        .lock()
        .map_err(|_| AppError::internal("proxy.lock"))?;
    Ok(entries
        .iter()
        .map(|(id, runtime)| ProxyRuntime {
            group_id: id.clone(),
            host_id: runtime.group.host_id.clone(),
            session_id: runtime.session_id.clone(),
            socks_endpoint: runtime.endpoint.clone(),
            active_connections: runtime
                .connections
                .lock()
                .map(|value| value.len())
                .unwrap_or_default()
                + runtime
                    .pending
                    .lock()
                    .map(|value| value.len())
                    .unwrap_or_default(),
            exposure_warning: runtime
                .group
                .listen_host
                .parse::<std::net::IpAddr>()
                .is_ok_and(|address| !address.is_loopback()),
            started_at: runtime.started_at,
            revision: runtime.revision.clone(),
        })
        .collect())
}

pub fn connections(app: &AppHandle, group_id: Option<&str>) -> AppResult<Vec<ProxyConnection>> {
    let state = app.state::<AppState>();
    let entries = state
        .proxy
        .active
        .lock()
        .map_err(|_| AppError::internal("proxy.lock"))?;
    let mut result = Vec::new();
    for (owner, runtime) in entries.iter() {
        if group_id.is_some_and(|id| id != owner) {
            continue;
        }
        let entries = runtime
            .connections
            .lock()
            .map_err(|_| AppError::internal("proxy.lock"))?;
        for (id, connection) in entries.iter() {
            let (status, error) = connection
                .status
                .lock()
                .map(|value| value.clone())
                .unwrap_or_else(|_| ("unknown".into(), None));
            result.push(ProxyConnection {
                id: id.clone(),
                group_id: connection.group_id.clone(),
                route_id: connection.route_id.clone(),
                source: connection.source.clone(),
                target: connection.target.clone(),
                bytes_up: connection.bytes_up.load(Ordering::Relaxed),
                bytes_down: connection.bytes_down.load(Ordering::Relaxed),
                started_at: connection.started_at,
                status,
                error,
            });
        }
        let pending = runtime
            .pending
            .lock()
            .map_err(|_| AppError::internal("proxy.lock"))?;
        for (id, connection) in pending.iter() {
            let (status, error) = connection
                .status
                .lock()
                .map(|value| value.clone())
                .unwrap_or_else(|_| ("unknown".into(), None));
            result.push(ProxyConnection {
                id: id.clone(),
                group_id: connection.group_id.clone(),
                route_id: None,
                source: connection.source.clone(),
                target: String::new(),
                bytes_up: 0,
                bytes_down: 0,
                started_at: connection.started_at,
                status,
                error,
            });
        }
    }
    result.sort_by_key(|entry| std::cmp::Reverse(entry.started_at));
    Ok(result)
}

pub fn close_connection(app: &AppHandle, id: &str) -> AppResult<()> {
    let state = app.state::<AppState>();
    let active = state
        .proxy
        .active
        .lock()
        .map_err(|_| AppError::internal("proxy.lock"))?;
    for runtime in active.values() {
        if close_pending(&runtime.pending, id) {
            return Ok(());
        }
        if let Ok(entries) = runtime.connections.lock() {
            if let Some(connection) = entries.get(id) {
                let _ = connection.cancel.send(true);
                return Ok(());
            }
        }
    }
    Err(AppError::validation("proxy.connectionMissing"))
}

pub fn attach(app: &AppHandle, group_id: &str) -> AppResult<TunAttach> {
    let state = app.state::<AppState>();
    let active = state
        .proxy
        .active
        .lock()
        .map_err(|_| AppError::internal("proxy.lock"))?;
    let runtime = active
        .get(group_id)
        .ok_or_else(|| AppError::validation("proxy.notRunning"))?;
    let snap = snapshot(app, Some(group_id))?
        .into_iter()
        .next()
        .ok_or_else(|| AppError::validation("proxy.groupMissing"))?;
    if snap.group.revision != runtime.revision {
        return Err(AppError::validation("proxy.changed"));
    }
    let username = format!("tun-{}", uuid::Uuid::new_v4());
    let password = uuid::Uuid::new_v4().to_string();
    if let Ok(mut auth) = runtime.attach_auth.write() {
        *auth = Some((username.clone(), password.clone()));
    }
    Ok(TunAttach {
        group_id: group_id.into(),
        revision: snap.group.revision,
        socks_endpoint: runtime.endpoint.clone(),
        username: Some(username),
        password: Some(password),
        routes: snap.routes,
    })
}

pub fn stop_owned(app: &AppHandle, owner: &str, generation: u64) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let removed: Vec<_> = state
        .proxy
        .active
        .lock()
        .ok()
        .map(|mut entries| {
            let ids: Vec<_> = entries
                .iter()
                .filter(|(_, runtime)| {
                    runtime
                        .owner
                        .as_ref()
                        .is_some_and(|(id, value)| id == owner && *value == generation)
                })
                .map(|(id, _)| id.clone())
                .collect();
            ids.into_iter()
                .filter_map(|id| entries.remove(&id))
                .collect()
        })
        .unwrap_or_default();
    for runtime in removed {
        state.proxy.pause(&runtime.group.id);
        let _ = runtime.cancel.send(true);
        if let Ok(entries) = runtime.pending.lock() {
            for connection in entries.values() {
                let _ = connection.cancel.send(true);
            }
        }
        if let Ok(entries) = runtime.connections.lock() {
            for connection in entries.values() {
                let _ = connection.cancel.send(true);
            }
        }
        for listener in &runtime.listeners {
            listener.abort();
        }
        if let Ok(transport) =
            state
                .ssh
                .take_forwarding_purpose(&runtime.group.host_id, &runtime.session_id, "proxy")
        {
            tauri::async_runtime::spawn(async move {
                let _ = transport.finish().await;
            });
        }
    }
    publish(app);
}

pub fn stop_session(app: &AppHandle, session: &str) {
    stop_session_with_pause(app, session, true);
}

/// A transport that closes unexpectedly may be retried by automatic startup.
/// Explicit disconnects and manual stops remain paused until the user starts
/// the group again.
pub fn stop_session_reconnectable(app: &AppHandle, session: &str) {
    stop_session_with_pause(app, session, false);
}

fn stop_session_with_pause(app: &AppHandle, session: &str, pause: bool) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let ids: Vec<_> = state
        .proxy
        .active
        .lock()
        .map(|entries| {
            entries
                .iter()
                .filter(|(_, active)| active.session_id == session)
                .map(|(id, _)| id.clone())
                .collect()
        })
        .unwrap_or_default();
    for id in ids {
        let state = app.state::<AppState>();
        let removed = state
            .proxy
            .active
            .lock()
            .ok()
            .and_then(|mut active| active.remove(&id));
        if let Some(runtime) = removed {
            if pause || !runtime.group.auto_retry {
                state.proxy.pause(&id);
            }
            let _ = runtime.cancel.send(true);
            if let Ok(entries) = runtime.pending.lock() {
                for connection in entries.values() {
                    let _ = connection.cancel.send(true);
                }
            }
            if let Ok(entries) = runtime.connections.lock() {
                for connection in entries.values() {
                    let _ = connection.cancel.send(true);
                }
            }
            for listener in &runtime.listeners {
                listener.abort();
            }
            let transport = state.ssh.take_forwarding_purpose(
                &runtime.group.host_id,
                &runtime.session_id,
                "proxy",
            );
            if let Ok(transport) = transport {
                tauri::async_runtime::spawn(async move {
                    let _ = transport.finish().await;
                });
            }
        }
    }
    publish(app);
}

pub fn stop_all(app: &AppHandle) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let active: Vec<_> = state
        .proxy
        .active
        .lock()
        .map(|mut entries| entries.drain().map(|(_, value)| value).collect())
        .unwrap_or_default();
    for runtime in active {
        let _ = runtime.cancel.send(true);
        if let Ok(entries) = runtime.pending.lock() {
            for connection in entries.values() {
                let _ = connection.cancel.send(true);
            }
        }
        if let Ok(entries) = runtime.connections.lock() {
            for connection in entries.values() {
                let _ = connection.cancel.send(true);
            }
        }
        for listener in &runtime.listeners {
            listener.abort();
        }
        if let Ok(transport) =
            state
                .ssh
                .take_forwarding_purpose(&runtime.group.host_id, &runtime.session_id, "proxy")
        {
            tauri::async_runtime::spawn(async move {
                let _ = transport.finish().await;
            });
        }
    }
    publish(app);
}
