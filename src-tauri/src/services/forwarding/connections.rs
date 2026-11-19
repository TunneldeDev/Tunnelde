//! A single weak pool for UI, automation and plugins. Pending acquisitions and
//! admitted listeners own the transport; the final owner disconnects it.
use super::contract::RevisionedRule;
use crate::{
    error::{AppError, AppResult},
    ssh::{session::review::Target, SessionInfo, SshConnectRequest},
    state::AppState,
};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, Weak},
};
use tauri::{AppHandle, Manager};

type Slot<T> = Arc<tokio::sync::Mutex<Weak<T>>>;
struct WeakPool<T>(Mutex<HashMap<String, Slot<T>>>);
impl<T> Default for WeakPool<T> {
    fn default() -> Self {
        Self(Mutex::new(HashMap::new()))
    }
}
impl<T> WeakPool<T> {
    fn slot(&self, key: String) -> Slot<T> {
        let mut pool = self.0.lock().unwrap_or_else(|e| e.into_inner());
        pool.retain(|_, slot| {
            Arc::strong_count(slot) > 1
                || slot
                    .try_lock()
                    .map_or(true, |value| value.strong_count() > 0)
        });
        pool.entry(key).or_default().clone()
    }
    async fn acquire<F: std::future::Future<Output = AppResult<T>>>(
        &self,
        key: String,
        active: impl Fn(&T) -> AppResult<bool>,
        connect: impl FnOnce() -> F,
    ) -> AppResult<Arc<T>> {
        let slot = self.slot(key);
        let mut slot = slot.lock().await;
        if let Some(connection) = slot.upgrade() {
            if active(&connection)? {
                return Ok(connection);
            }
        }
        let connection = Arc::new(connect().await?);
        *slot = Arc::downgrade(&connection);
        Ok(connection)
    }
}
#[derive(Default)]
pub(crate) struct Pool(WeakPool<Connection>);
pub(crate) struct Connection {
    app: AppHandle,
    pub info: SessionInfo,
    route: String,
}
impl Drop for Connection {
    fn drop(&mut self) {
        let _ = crate::ssh::disconnect(&self.app, &self.info.id);
    }
}
fn key(entry: &RevisionedRule) -> String {
    // Tag group/rule keys so equal user-provided identifiers cannot collide.
    serde_json::to_string(&(
        &entry.rule.host_id,
        if entry.group_id.is_some() {
            "group"
        } else {
            "rule"
        },
        entry.group_id.as_deref().unwrap_or(&entry.rule.id),
    ))
    .expect("string tuple")
}
impl Pool {
    pub(crate) async fn existing(
        &self,
        app: &AppHandle,
        entry: &RevisionedRule,
        target: &Target,
        session: &str,
    ) -> AppResult<Arc<Connection>> {
        let slot = self.0.slot(key(entry));
        let connection = slot.lock().await.upgrade().filter(|connection| {
            connection.info.id == session
                && connection.route == target.review().identity()
                && app.state::<AppState>().ssh.is_active(session)
        });
        connection.ok_or_else(|| AppError::validation("forward.sessionScope"))
    }
    pub(crate) async fn acquire(
        &self,
        app: &AppHandle,
        entry: &RevisionedRule,
        target: &Target,
        mut request: SshConnectRequest,
    ) -> AppResult<Arc<Connection>> {
        if request.host_id != entry.rule.host_id {
            return Err(AppError::validation("ssh.connectionChanged"));
        }
        target.verify_background(app).await?;
        request.background = true;
        request.purpose = Some("forwarding".into());
        self.0
            .acquire(
                key(entry),
                |connection| {
                    let active = app.state::<AppState>().ssh.is_active(&connection.info.id);
                    if active && connection.route != target.review().identity() {
                        return Err(AppError::validation("forward.groupConnectionChanged"));
                    }
                    Ok(active)
                },
                || async {
                    let info = target.connect(app.clone(), request, false, false).await?;
                    Ok(Connection {
                        app: app.clone(),
                        info,
                        route: target.review().identity().into(),
                    })
                },
            )
            .await
    }
}
pub(crate) fn request(host: &str) -> SshConnectRequest {
    SshConnectRequest {
        host_id: host.into(),
        background: true,
        purpose: Some("forwarding".into()),
        password: None,
        passphrase: None,
        jump_credentials: HashMap::new(),
        cols: 80,
        rows: 24,
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pool_keys_share_only_within_the_exact_host_and_group() {
        let rule = serde_json::from_value(serde_json::json!({"id":"r1","hostId":"h1","name":"rule","mode":"local","bindHost":"127.0.0.1","bindPort":8080,"targetHost":"127.0.0.1","targetPort":80})).unwrap();
        let mut a = RevisionedRule {
            rule,
            group_id: None,
            revision: "v1".into(),
        };
        let mut b = a.clone();
        b.rule.id = "r2".into();
        assert_ne!(key(&a), key(&b));
        a.group_id = Some("group1".into());
        b.group_id = a.group_id.clone();
        assert_eq!(key(&a), key(&b));
        b.group_id = Some("group2".into());
        assert_ne!(key(&a), key(&b));
        b.group_id = a.group_id.clone();
        b.rule.host_id = "h2".into();
        assert_ne!(key(&a), key(&b));
        b = a.clone();
        b.group_id = None;
        b.rule.id = "group1".into();
        assert_ne!(key(&a), key(&b));
    }
}

#[cfg(test)]
mod lifecycle_tests {
    use super::*;
    use crate::ssh::{
        forward::{ForwardRegistry, RemoteRoutes},
        session::ClientHandler,
    };
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    struct Transport {
        handle: Arc<russh::client::Handle<ClientHandler>>,
        routes: Arc<RemoteRoutes>,
        server: tokio::task::JoinHandle<()>,
        active: AtomicBool,
        dropped: Arc<AtomicUsize>,
    }
    impl Drop for Transport {
        fn drop(&mut self) {
            self.server.abort();
            self.dropped.fetch_add(1, Ordering::SeqCst);
        }
    }
    async fn acquire(
        pool: &WeakPool<Transport>,
        key: &str,
        created: &AtomicUsize,
        dropped: &Arc<AtomicUsize>,
    ) -> Arc<Transport> {
        pool.acquire(
            key.into(),
            |connection| Ok(connection.active.load(Ordering::SeqCst)),
            || async {
                created.fetch_add(1, Ordering::SeqCst);
                let (handle, routes, server) = crate::ssh::forward::protocol_tests::fixture().await;
                Ok(Transport {
                    handle,
                    routes,
                    server,
                    active: AtomicBool::new(true),
                    dropped: dropped.clone(),
                })
            },
        )
        .await
        .unwrap()
    }
    async fn listener(
        registry: &ForwardRegistry,
        connection: Arc<Transport>,
        id: &str,
    ) -> super::super::contract::ForwardRule {
        let socket = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let port = socket.local_addr().unwrap().port();
        drop(socket);
        let rule=serde_json::from_value(serde_json::json!({"id":id,"hostId":"host","name":id,"mode":"local","bindHost":"127.0.0.1","bindPort":port,"targetHost":"127.0.0.1","targetPort":80})).unwrap();
        crate::ssh::forward::prepare_scoped(
            registry,
            &rule,
            "session",
            connection.handle.clone(),
            connection.routes.clone(),
            None,
            connection,
        )
        .await
        .unwrap()
        .commit(registry, || Ok(()))
        .unwrap();
        rule
    }
    #[tokio::test]
    async fn concurrent_manual_and_automatic_acquisitions_share_ssh_and_final_listener_releases_it()
    {
        let pool = WeakPool::default();
        let created = AtomicUsize::new(0);
        let dropped = Arc::new(AtomicUsize::new(0));
        let (manual, automatic) = tokio::join!(
            acquire(&pool, "group1", &created, &dropped),
            acquire(&pool, "group1", &created, &dropped)
        );
        assert!(Arc::ptr_eq(&manual, &automatic));
        assert_eq!(created.load(Ordering::SeqCst), 1);
        let registry = ForwardRegistry::default();
        let first = listener(&registry, manual.clone(), "manual").await;
        let second = listener(&registry, automatic.clone(), "automatic").await;
        drop(manual);
        drop(automatic);
        assert_eq!(dropped.load(Ordering::SeqCst), 0);
        registry.stop(&first.id).await.unwrap();
        assert_eq!(dropped.load(Ordering::SeqCst), 0);
        registry.stop(&second.id).await.unwrap();
        assert_eq!(dropped.load(Ordering::SeqCst), 1);
        // Weak entries cannot keep an idle SSH session alive.
        let new = acquire(&pool, "group1", &created, &dropped).await;
        assert_eq!(created.load(Ordering::SeqCst), 2);
        drop(new);
        assert_eq!(dropped.load(Ordering::SeqCst), 2);
    }
    #[tokio::test]
    async fn independent_scopes_and_failed_transport_replacement_do_not_disconnect_other_groups() {
        let pool = WeakPool::default();
        let created = AtomicUsize::new(0);
        let dropped = Arc::new(AtomicUsize::new(0));
        let a = acquire(&pool, "group1", &created, &dropped).await;
        let b = acquire(&pool, "group2", &created, &dropped).await;
        assert!(!Arc::ptr_eq(&a, &b));
        assert_eq!(created.load(Ordering::SeqCst), 2);
        a.active.store(false, Ordering::SeqCst);
        let replacement = acquire(&pool, "group1", &created, &dropped).await;
        assert!(!Arc::ptr_eq(&a, &replacement));
        assert_eq!(created.load(Ordering::SeqCst), 3);
        let still_b = acquire(&pool, "group2", &created, &dropped).await;
        assert!(Arc::ptr_eq(&b, &still_b));
        drop(a);
        drop(replacement);
        assert_eq!(dropped.load(Ordering::SeqCst), 2);
        drop(b);
        drop(still_b);
        assert_eq!(dropped.load(Ordering::SeqCst), 3);
    }
    #[tokio::test]
    async fn changed_route_cannot_create_a_second_connection_in_an_active_group() {
        let pool = WeakPool::default();
        let created = AtomicUsize::new(0);
        let dropped = Arc::new(AtomicUsize::new(0));
        let original = acquire(&pool, "group", &created, &dropped).await;
        let result = pool
            .acquire(
                "group".into(),
                |_| Err(AppError::validation("forward.groupConnectionChanged")),
                || async { panic!("must not open a second transport") },
            )
            .await;
        assert!(result.is_err());
        assert_eq!(created.load(Ordering::SeqCst), 1);
        assert_eq!(dropped.load(Ordering::SeqCst), 0);
        drop(original);
        let replacement = acquire(&pool, "group", &created, &dropped).await;
        assert_eq!(created.load(Ordering::SeqCst), 2);
        drop(replacement);
    }
}
