use super::{
    destination,
    registry::{self, Connection, Pending, Registry},
};
use crate::{
    plugins::runners::{Coordinator, Record},
    ssh::session::SessionIdentity,
};
use std::sync::{Arc, Mutex};

fn pending() -> Arc<Pending> {
    let coordinator = Coordinator::default();
    let record: Record = serde_json::from_value(serde_json::json!({
        "runnerId":"task", "stopPending":false,
        "deployment":{"hostId":"host", "directory":"/runner", "platform":"posix",
        "executable":"helper", "runner":"helper", "entry":"main"}
    }))
    .unwrap();
    Arc::new(Pending {
        plugin_id: "removed-plugin".into(),
        token: "a".repeat(64),
        record,
        cancelled: tokio::sync::watch::channel(false).0,
        connection: Mutex::new(Connection::default()),
        _lease: coordinator.admit("removed-plugin", "task").unwrap(),
    })
}

#[test]
fn missing_captured_identity_requires_review_instead_of_guessing_a_connection() {
    let value = pending();
    assert!(destination::identity(&value.record).is_err());
}

#[test]
fn registry_bounds_pending_connections_and_does_not_replace_an_existing_request() {
    let registry = Registry::default();
    let first = pending();
    registry.insert("first".into(), first.clone()).unwrap();
    assert!(registry.insert("first".into(), pending()).is_err());
    assert!(Arc::ptr_eq(&first, &registry.get("first").unwrap()));
    for index in 1..8 {
        registry.insert(index.to_string(), pending()).unwrap();
    }
    assert!(registry.insert("overflow".into(), pending()).is_err());
    registry.remove("first").unwrap();
    assert!(*first.cancelled.borrow());
    assert!(registry.get("first").is_err());
    registry.insert("replacement".into(), pending()).unwrap();
}

#[test]
fn old_expiry_cannot_cancel_a_new_acquisition_reusing_the_same_request_id() {
    let registry = Registry::default();
    let old = pending();
    registry.insert("same".into(), old.clone()).unwrap();
    registry.remove("same").unwrap();
    let current = pending();
    registry.insert("same".into(), current.clone()).unwrap();
    assert!(registry.remove_matching("same", &old).is_none());
    assert!(!*current.cancelled.borrow());
    assert!(registry.remove_matching("same", &current).is_some());
    assert!(*current.cancelled.borrow());
}

#[test]
fn cancellation_waits_for_the_current_synchronous_commit_then_revokes_authority() {
    let registry = Arc::new(Registry::default());
    let pending = pending();
    registry.insert("commit".into(), pending.clone()).unwrap();
    let commit = pending.connection.lock().unwrap();
    let (attempt, attempted) = std::sync::mpsc::channel();
    let (done, finished) = std::sync::mpsc::channel();
    let task_registry = registry.clone();
    let worker = std::thread::spawn(move || {
        attempt.send(()).unwrap();
        task_registry.remove("commit").unwrap();
        done.send(()).unwrap();
    });
    attempted.recv().unwrap();
    assert!(finished
        .recv_timeout(std::time::Duration::from_millis(20))
        .is_err());
    assert!(!*pending.cancelled.borrow());
    drop(commit);
    finished
        .recv_timeout(std::time::Duration::from_secs(2))
        .unwrap();
    worker.join().unwrap();
    assert!(*pending.cancelled.borrow());
    assert!(registry.get("commit").is_err());
}

#[tokio::test]
async fn cancellation_before_subscription_does_not_start_network_work() {
    let pending = pending();
    pending.cancelled.send_replace(true);
    let result = registry::guard(&pending, async {
        panic!("cancelled network future polled");
        #[allow(unreachable_code)]
        Ok(())
    })
    .await;
    assert!(result.is_err());
}

#[tokio::test]
async fn cancelling_a_pending_probe_drops_its_transport_future() {
    struct Dropped(Arc<std::sync::atomic::AtomicBool>);
    impl Drop for Dropped {
        fn drop(&mut self) {
            self.0.store(true, std::sync::atomic::Ordering::SeqCst);
        }
    }
    let pending = pending();
    let dropped = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let (started, ready) = tokio::sync::oneshot::channel();
    let task_pending = pending.clone();
    let guard = Dropped(dropped.clone());
    let task = tokio::spawn(async move {
        registry::guard(&task_pending, async {
            let _guard = guard;
            started.send(()).unwrap();
            std::future::pending::<crate::error::AppResult<()>>().await
        })
        .await
    });
    ready.await.unwrap();
    pending.cancelled.send_replace(true);
    assert!(task.await.unwrap().is_err());
    assert!(dropped.load(std::sync::atomic::Ordering::SeqCst));
}

#[test]
fn saved_destination_changes_are_rejected_before_transport_acquisition() {
    let host: crate::models::Host = serde_json::from_value(serde_json::json!({
        "id":"host", "groupId":null, "name":"Host", "host":"server", "port":22,
        "username":"user", "authMethod":"password", "keyPath":null, "favorite":false,
        "color":null, "tags":[], "note":null, "sortOrder":0, "lastUsedAt":null,
        "createdAt":0, "updatedAt":0
    }))
    .unwrap();
    let expected = SessionIdentity {
        host_id: "host".into(),
        address: "user@server:22".into(),
        server_key: "SHA256:original".into(),
    };
    assert!(expected.verify_host(&host).is_ok());
    for index in 0..4 {
        let mut edited = host.clone();
        match index {
            0 => edited.id = "other".into(),
            1 => edited.username = "other".into(),
            2 => edited.host = "other".into(),
            _ => edited.port = 2222,
        }
        assert!(expected.verify_host(&edited).is_err());
    }
    let mut renamed = host;
    renamed.name = "Renamed".into();
    assert!(expected.verify_host(&renamed).is_ok());
}
