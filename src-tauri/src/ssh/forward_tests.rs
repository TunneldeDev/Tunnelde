use super::*;
use russh::server::{self, Server as _, Session};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    task::JoinHandle,
};

#[derive(Default)]
struct Gate {
    entered: tokio::sync::Notify,
    release: tokio::sync::Notify,
}
#[derive(Default)]
struct TestServer {
    listeners: HashMap<(String, u16), JoinHandle<()>>,
    gate: Option<Arc<Gate>>,
    cancel_gate: Option<Arc<Gate>>,
}
impl server::Server for TestServer {
    type Handler = Self;
    fn new_client(&mut self, _: Option<std::net::SocketAddr>) -> Self {
        Self {
            gate: self.gate.clone(),
            cancel_gate: self.cancel_gate.clone(),
            listeners: HashMap::new(),
        }
    }
}
impl Drop for TestServer {
    fn drop(&mut self) {
        for (_, task) in self.listeners.drain() {
            task.abort();
        }
    }
}
impl server::Handler for TestServer {
    type Error = russh::Error;
    async fn auth_none(&mut self, _: &str) -> Result<server::Auth, Self::Error> {
        Ok(server::Auth::Accept)
    }
    async fn channel_open_direct_tcpip(
        &mut self,
        channel: Channel<server::Msg>,
        host: &str,
        port: u32,
        _: &str,
        _: u32,
        reply: server::ChannelOpenHandle,
        _: &mut Session,
    ) -> Result<(), Self::Error> {
        let host = host.to_owned();
        tokio::spawn(async move {
            let Ok(mut socket) = TcpStream::connect((host.as_str(), port as u16)).await else {
                return;
            };
            reply.accept().await;
            let mut stream = channel.into_stream();
            let _ = copy_bidirectional(&mut socket, &mut stream).await;
        });
        Ok(())
    }
    async fn tcpip_forward(
        &mut self,
        address: &str,
        port: &mut u32,
        session: &mut Session,
    ) -> Result<bool, Self::Error> {
        let Ok(listener) = TcpListener::bind((address, *port as u16)).await else {
            return Ok(false);
        };
        let local = listener.local_addr().unwrap();
        let handle = session.handle();
        let address = address.to_owned();
        let key = (address.clone(), local.port());
        let task = tokio::spawn(async move {
            loop {
                let Ok((mut socket, origin)) = listener.accept().await else {
                    break;
                };
                let h = handle.clone();
                let address = address.clone();
                tokio::spawn(async move {
                    let Ok(channel) = h
                        .channel_open_forwarded_tcpip(
                            address,
                            local.port() as u32,
                            origin.ip().to_string(),
                            origin.port() as u32,
                        )
                        .await
                    else {
                        return;
                    };
                    let mut stream = channel.into_stream();
                    let _ = copy_bidirectional(&mut socket, &mut stream).await;
                });
            }
        });
        self.listeners.insert(key, task);
        if let Some(gate) = &self.gate {
            gate.entered.notify_one();
            gate.release.notified().await;
        }
        Ok(true)
    }
    async fn cancel_tcpip_forward(
        &mut self,
        address: &str,
        port: u32,
        _: &mut Session,
    ) -> Result<bool, Self::Error> {
        if let Some(gate) = &self.cancel_gate {
            gate.entered.notify_one();
            gate.release.notified().await;
        }
        if let Some(task) = self.listeners.remove(&(address.to_owned(), port as u16)) {
            task.abort();
            Ok(true)
        } else {
            Ok(false)
        }
    }
}
async fn fixture() -> (
    Arc<client::Handle<ClientHandler>>,
    Arc<RemoteRoutes>,
    JoinHandle<()>,
) {
    let (address, fingerprint, task) = test_server().await;
    let socket = TcpStream::connect(address).await.unwrap();
    let (mut client, _, routes) =
        super::super::session::handshake(Box::pin(socket), Some(fingerprint))
            .await
            .unwrap();
    assert!(client.authenticate_none("test").await.unwrap().success());
    (Arc::new(client), routes, task)
}
async fn test_server() -> (std::net::SocketAddr, String, JoinHandle<()>) {
    gated_server(None).await
}
async fn gated_server(gate: Option<Arc<Gate>>) -> (std::net::SocketAddr, String, JoinHandle<()>) {
    server_with_gates(gate, None).await
}
async fn server_with_gates(
    gate: Option<Arc<Gate>>,
    cancel_gate: Option<Arc<Gate>>,
) -> (std::net::SocketAddr, String, JoinHandle<()>) {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let address = listener.local_addr().unwrap();
    let key =
        russh::keys::PrivateKey::random(&mut rand::rng(), russh::keys::Algorithm::Ed25519).unwrap();
    let fingerprint = key
        .public_key()
        .fingerprint(russh::keys::HashAlg::Sha256)
        .to_string();
    let config = server::Config {
        keys: vec![key],
        ..Default::default()
    };
    let task = tokio::spawn(async move {
        let mut server = TestServer {
            gate,
            cancel_gate,
            listeners: HashMap::new(),
        };
        let _ = server.run_on_socket(Arc::new(config), &listener).await;
    });
    (address, fingerprint, task)
}
#[tokio::test]
async fn explicit_stop_waits_for_remote_release_before_immediate_restart() {
    let gate = Arc::new(Gate::default());
    let (address, fingerprint, server) = server_with_gates(None, Some(gate.clone())).await;
    let socket = TcpStream::connect(address).await.unwrap();
    let (mut client, _, routes) =
        super::super::session::handshake(Box::pin(socket), Some(fingerprint))
            .await
            .unwrap();
    assert!(client.authenticate_none("test").await.unwrap().success());
    let handle = Arc::new(client);
    let (target_port, echo_task) = echo().await;
    let port = free_port().await;
    let rule = ForwardRule {
        id: "restart".into(),
        host_id: "h".into(),
        name: "restart".into(),
        mode: "remote".into(),
        bind_host: "127.0.0.1".into(),
        bind_port: port,
        target_host: "127.0.0.1".into(),
        target_port,
    };
    let active = open_forward(handle.clone(), routes.clone(), &rule, "session", None)
        .await
        .unwrap();
    let registry = Arc::new(ForwardRegistry::default());
    registry
        .active
        .lock()
        .unwrap()
        .insert(rule.id.clone(), active);
    drop(roundtrip(port).await);
    let stop_registry = registry.clone();
    let stopping = tokio::spawn(async move { stop_registry.stop("restart").await });
    tokio::time::timeout(Duration::from_secs(3), gate.entered.notified())
        .await
        .unwrap();
    assert!(
        !stopping.is_finished(),
        "Stop completed before the server released the port"
    );
    gate.release.notify_one();
    tokio::time::timeout(Duration::from_secs(3), stopping)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let restarted = open_forward(handle, routes, &rule, "session", None)
        .await
        .unwrap();
    drop(roundtrip(port).await);
    drop(restarted);
    server.abort();
    echo_task.abort();
}

#[tokio::test]
async fn detached_cleanup_cannot_cancel_a_new_listener_on_the_same_port() {
    let gate = Arc::new(Gate::default());
    let (address, fingerprint, server) = server_with_gates(None, Some(gate.clone())).await;
    let socket = TcpStream::connect(address).await.unwrap();
    let (mut client, _, routes) =
        super::super::session::handshake(Box::pin(socket), Some(fingerprint))
            .await
            .unwrap();
    assert!(client.authenticate_none("test").await.unwrap().success());
    let handle = Arc::new(client);
    let (target_port, echo_task) = echo().await;
    let rule = ForwardRule {
        id: "restart".into(),
        host_id: "h".into(),
        name: "restart".into(),
        mode: "remote".into(),
        bind_host: "127.0.0.1".into(),
        bind_port: free_port().await,
        target_host: "127.0.0.1".into(),
        target_port,
    };
    drop(
        open_forward(handle.clone(), routes.clone(), &rule, "session", None)
            .await
            .unwrap(),
    );
    tokio::time::timeout(Duration::from_secs(3), gate.entered.notified())
        .await
        .unwrap();
    let restart_handle = handle.clone();
    let restart_routes = routes.clone();
    let restart_rule = rule.clone();
    let restarting = tokio::spawn(async move {
        open_forward(
            restart_handle,
            restart_routes,
            &restart_rule,
            "session",
            None,
        )
        .await
    });
    // Let the replacement reach its endpoint reservation wait.
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert!(!restarting.is_finished());
    gate.release.notify_one();
    let restarted = tokio::time::timeout(Duration::from_secs(3), restarting)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    drop(roundtrip(rule.bind_port).await);
    assert!(!*routes
        .entries
        .lock()
        .unwrap()
        .values()
        .next()
        .unwrap()
        .cancel
        .borrow());

    let registry = Arc::new(ForwardRegistry::default());
    registry
        .active
        .lock()
        .unwrap()
        .insert(rule.id.clone(), restarted);
    let stop_registry = registry.clone();
    let stopping = tokio::spawn(async move { stop_registry.stop("restart").await });
    tokio::time::timeout(Duration::from_secs(3), gate.entered.notified())
        .await
        .unwrap();
    stopping.abort();
    assert!(stopping.await.unwrap_err().is_cancelled());
    gate.release.notify_one();
    tokio::time::timeout(Duration::from_secs(3), async {
        while !routes.entries.lock().unwrap().is_empty() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    assert!(TcpStream::connect(("127.0.0.1", rule.bind_port))
        .await
        .is_err());
    server.abort();
    echo_task.abort();
}

#[tokio::test]
async fn uncertain_remote_release_blocks_reuse_until_ssh_disconnects() {
    let (handle, routes, server) = fixture().await;
    let port = free_port().await;
    let rule = ForwardRule {
        id: "uncertain".into(),
        host_id: "h".into(),
        name: "uncertain".into(),
        mode: "remote".into(),
        bind_host: "127.0.0.1".into(),
        bind_port: port,
        target_host: "127.0.0.1".into(),
        target_port: 80,
    };
    let active = open_forward(handle.clone(), routes.clone(), &rule, "session", None)
        .await
        .unwrap();
    // Make the next cancellation fail while preserving the route reservation.
    handle
        .cancel_tcpip_forward("127.0.0.1", port as u32)
        .await
        .unwrap();
    let registry = ForwardRegistry::default();
    registry
        .active
        .lock()
        .unwrap()
        .insert(rule.id.clone(), active);
    assert!(
        matches!(registry.stop(&rule.id).await, Err(AppError::Ssh(message)) if message == "forward.stopFailed")
    );
    let restart = tokio::time::timeout(
        Duration::from_secs(1),
        open_forward(handle, routes, &rule, "session", None),
    )
    .await
    .unwrap();
    assert!(matches!(restart, Err(AppError::Ssh(message)) if message == "forward.stopFailed"));
    server.abort();
}

#[tokio::test]
async fn local_stop_returns_only_after_port_can_be_rebound() {
    let (handle, routes, server) = fixture().await;
    let rule = ForwardRule {
        id: "local".into(),
        host_id: "h".into(),
        name: "local".into(),
        mode: "local".into(),
        bind_host: "127.0.0.1".into(),
        bind_port: free_port().await,
        target_host: "127.0.0.1".into(),
        target_port: 80,
    };
    let active = open_forward(handle, routes, &rule, "session", None)
        .await
        .unwrap();
    let registry = ForwardRegistry::default();
    registry
        .active
        .lock()
        .unwrap()
        .insert(rule.id.clone(), active);
    registry.stop(&rule.id).await.unwrap();
    let rebound = TcpListener::bind(("127.0.0.1", rule.bind_port))
        .await
        .unwrap();
    drop(rebound);
    server.abort();
}
async fn echo() -> (u16, JoinHandle<()>) {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let task = tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else {
                break;
            };
            tokio::spawn(async move {
                let (mut read, mut write) = socket.split();
                let _ = tokio::io::copy(&mut read, &mut write).await;
            });
        }
    });
    (port, task)
}
async fn free_port() -> u16 {
    TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}
async fn roundtrip(port: u16) -> TcpStream {
    let mut socket = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let data: Vec<u8> = (0..131_072).map(|i| (i % 251) as u8).collect();
    let (mut read, mut write) = socket.split();
    let mut received = vec![0; data.len()];
    tokio::time::timeout(Duration::from_secs(8), async {
        tokio::try_join!(write.write_all(&data), read.read_exact(&mut received)).unwrap();
    })
    .await
    .unwrap();
    assert_eq!(received, data);
    socket
}
async fn assert_closed(mut socket: TcpStream, port: u16) {
    let mut byte = [0];
    let result = tokio::time::timeout(Duration::from_secs(3), socket.read(&mut byte))
        .await
        .unwrap();
    assert!(result.is_err() || result.unwrap() == 0);
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if TcpStream::connect(("127.0.0.1", port)).await.is_err() {
                break;
            };
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
}
#[tokio::test]
async fn local_and_remote_roundtrip_and_stop_are_isolated() {
    let (local, local_routes, server1) = fixture().await;
    let (remote, remote_routes, server2) = fixture().await;
    let (target, echo) = echo().await;
    let p1 = free_port().await;
    let p2 = free_port().await;
    let make = |id: &str, mode: &str, port| ForwardRule {
        id: id.into(),
        host_id: "h".into(),
        name: "test".into(),
        mode: mode.into(),
        bind_host: "127.0.0.1".into(),
        bind_port: port,
        target_host: "127.0.0.1".into(),
        target_port: target,
    };
    let first = open_forward(
        local,
        local_routes,
        &make("local", "local", p1),
        "session1",
        None,
    )
    .await
    .unwrap();
    let second = open_forward(
        remote,
        remote_routes,
        &make("remote", "remote", p2),
        "session2",
        Some(("plugin".into(), 1)),
    )
    .await
    .unwrap();
    let registry = ForwardRegistry::default();
    {
        let mut active = registry.active.lock().unwrap();
        active.insert("local".into(), first);
        active.insert("remote".into(), second);
    }
    let one = roundtrip(p1).await;
    let two = roundtrip(p2).await;
    registry.stop_session("session1");
    assert_closed(one, p1).await;
    let remaining = roundtrip(p2).await;
    drop(remaining);
    registry.stop_before_generation("plugin", 1);
    registry.stop_generation("plugin", 2);
    drop(roundtrip(p2).await);
    registry.stop_before_generation("plugin", 2);
    assert_closed(two, p2).await;
    server1.abort();
    server2.abort();
    echo.abort();
}
#[tokio::test]
async fn multiple_forwards_share_one_ssh_connection_and_stop_independently() {
    let (handle, routes, server) = fixture().await;
    let (target, echo_task) = echo().await;
    let first_port = free_port().await;
    let mut second_port = free_port().await;
    while second_port == first_port {
        second_port = free_port().await;
    }
    let make = |id: &str, port| ForwardRule {
        id: id.into(),
        host_id: "h".into(),
        name: id.into(),
        mode: "local".into(),
        bind_host: "127.0.0.1".into(),
        bind_port: port,
        target_host: "127.0.0.1".into(),
        target_port: target,
    };
    let first = open_forward(
        handle.clone(),
        routes.clone(),
        &make("first", first_port),
        "shared",
        None,
    )
    .await
    .unwrap();
    let second = open_forward(handle, routes, &make("second", second_port), "shared", None)
        .await
        .unwrap();
    let registry = ForwardRegistry::default();
    {
        let mut active = registry.active.lock().unwrap();
        active.insert("first".into(), first);
        active.insert("second".into(), second);
    }
    let first_socket = roundtrip(first_port).await;
    let second_socket = roundtrip(second_port).await;
    registry.stop("first").await.unwrap();
    assert_closed(first_socket, first_port).await;
    drop(roundtrip(second_port).await);
    registry.stop_session("shared");
    assert_closed(second_socket, second_port).await;
    assert!(registry.active.lock().unwrap().is_empty());
    server.abort();
    echo_task.abort();
}
#[tokio::test]
async fn in_flight_start_tickets_are_invalidated_by_stop_and_disconnect() {
    let registry = ForwardRegistry::default();
    let ticket = registry.ticket("r", "s").unwrap();
    assert!(registry.valid_ticket(&ticket));
    registry.stop_session("other");
    assert!(registry.valid_ticket(&ticket));
    registry.stop("r").await.unwrap();
    assert!(!registry.valid_ticket(&ticket));
    let ticket = registry.ticket("r", "s").unwrap();
    registry.stop_session("s");
    assert!(!registry.valid_ticket(&ticket));
    let ticket = registry.ticket("r", "s").unwrap();
    registry.stop("r").await.unwrap();
    assert!(!registry.valid_ticket(&ticket));
    let ticket = registry.ticket("r", "s").unwrap();
    registry.stop_all();
    assert!(!registry.valid_ticket(&ticket));
}
#[test]
fn remote_routes_reject_unknown_and_ambiguous_bindings() {
    let routes = RemoteRoutes::default();
    let (_tx, rx) = watch::channel(false);
    let target = RemoteTarget {
        host: "localhost".into(),
        port: 80,
        cancel: rx,
    };
    routes
        .entries
        .lock()
        .unwrap()
        .insert(("localhost".into(), 1234), target.clone());
    assert!(routes.target("127.0.0.1", 1234).is_some());
    assert!(routes.target("::1", 1234).is_some());
    assert!(routes.target("192.0.2.1", 1234).is_none());
    assert!(routes.target("127.0.0.1", 9999).is_none());
    routes
        .entries
        .lock()
        .unwrap()
        .insert(("0.0.0.0".into(), 1234), target);
    assert!(routes.target("127.0.0.1", 1234).is_none());
}
#[tokio::test]
async fn nested_jump_transports_verify_each_hop_and_reject_changed_target_key() {
    let (first, _, server1) = fixture().await;
    let (second_address, second_key, server2) = test_server().await;
    let (target_address, target_key, server3) = test_server().await;
    let second_stream = first
        .channel_open_direct_tcpip("127.0.0.1", second_address.port() as u32, "127.0.0.1", 0)
        .await
        .unwrap()
        .into_stream();
    let (mut second, _, _) =
        super::super::session::handshake(Box::pin(second_stream), Some(second_key))
            .await
            .unwrap();
    assert!(second.authenticate_none("test").await.unwrap().success());
    let target_stream = second
        .channel_open_direct_tcpip("127.0.0.1", target_address.port() as u32, "127.0.0.1", 0)
        .await
        .unwrap()
        .into_stream();
    let (mut target, _, routes) =
        super::super::session::handshake(Box::pin(target_stream), Some(target_key))
            .await
            .unwrap();
    assert!(target.authenticate_none("test").await.unwrap().success());
    let (echo_port, echo_task) = echo().await;
    let listener_port = free_port().await;
    let rule = ForwardRule {
        id: "nested".into(),
        host_id: "h".into(),
        name: "nested".into(),
        mode: "local".into(),
        bind_host: "127.0.0.1".into(),
        bind_port: listener_port,
        target_host: "127.0.0.1".into(),
        target_port: echo_port,
    };
    let forward = open_forward(Arc::new(target), routes, &rule, "nested", None)
        .await
        .unwrap();
    let socket = roundtrip(listener_port).await;
    let wrong_stream = second
        .channel_open_direct_tcpip("127.0.0.1", target_address.port() as u32, "127.0.0.1", 0)
        .await
        .unwrap()
        .into_stream();
    let rejected = super::super::session::handshake(
        Box::pin(wrong_stream),
        Some("SHA256:unapproved-fingerprint".into()),
    )
    .await;
    assert!(rejected.is_err());
    drop(forward);
    assert_closed(socket, listener_port).await;
    server1.abort();
    server2.abort();
    server3.abort();
    echo_task.abort();
}
#[tokio::test]
async fn dropped_in_flight_remote_setup_revokes_route_and_cancels_late_listener() {
    let gate = Arc::new(Gate::default());
    let (address, fingerprint, server) = gated_server(Some(gate.clone())).await;
    let socket = TcpStream::connect(address).await.unwrap();
    let (mut client, _, routes) =
        super::super::session::handshake(Box::pin(socket), Some(fingerprint))
            .await
            .unwrap();
    assert!(client.authenticate_none("test").await.unwrap().success());
    let port = free_port().await;
    let keep_routes = routes.clone();
    let setup = tokio::spawn(async move {
        let rule = ForwardRule {
            id: "pending".into(),
            host_id: "h".into(),
            name: "pending".into(),
            mode: "remote".into(),
            bind_host: "127.0.0.1".into(),
            bind_port: port,
            target_host: "127.0.0.1".into(),
            target_port: 80,
        };
        open_forward(
            Arc::new(client),
            routes,
            &rule,
            "pending",
            Some(("plugin".into(), 1)),
        )
        .await
    });
    tokio::time::timeout(Duration::from_secs(3), gate.entered.notified())
        .await
        .unwrap();
    assert!(!keep_routes.entries.lock().unwrap().is_empty());
    setup.abort();
    assert!(matches!(setup.await, Err(error) if error.is_cancelled()));
    assert!(*keep_routes
        .entries
        .lock()
        .unwrap()
        .values()
        .next()
        .unwrap()
        .cancel
        .borrow());
    gate.release.notify_one();
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if TcpStream::connect(("127.0.0.1", port)).await.is_err()
                && keep_routes.entries.lock().unwrap().is_empty()
            {
                break;
            };
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    server.abort();
}
