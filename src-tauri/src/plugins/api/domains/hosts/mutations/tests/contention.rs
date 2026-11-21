use super::*;
use crate::services::operations::WorkLifetime;

struct Held {
    release: Option<std::sync::mpsc::Sender<()>>,
    owner: Option<std::thread::JoinHandle<()>>,
}
impl Held {
    async fn new(db: Database) -> Self {
        let (entered, ready) = tokio::sync::oneshot::channel();
        let (release, wait) = std::sync::mpsc::channel();
        let owner = std::thread::spawn(move || {
            db.with(|_| {
                entered.send(()).unwrap();
                let _ = wait.recv_timeout(Duration::from_secs(8));
                Ok(())
            })
            .unwrap();
        });
        ready.await.unwrap();
        Self {
            release: Some(release),
            owner: Some(owner),
        }
    }
}
impl Drop for Held {
    fn drop(&mut self) {
        let _ = self.release.take().unwrap().send(());
        self.owner.take().unwrap().join().unwrap();
    }
}
async fn attempted(origin: &Origin) {
    tokio::time::timeout(Duration::from_secs(2), async {
        while origin.attempts.load(Ordering::SeqCst) == 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn revoked_retired_and_cancelled_crud_exit_before_db_unlock_without_late_effects() {
    for reason in ["retired", "revoked", "cancelled"] {
        let f = Arc::new(Fixture::new("hosts.write"));
        let before = f.state();
        let held = Held::new(f.db.clone()).await;
        let worker_fixture = f.clone();
        let (finished, done) = tokio::sync::oneshot::channel();
        let caller = tokio::spawn(async move {
            worker(move |cancel| {
                let result = worker_fixture.execute_checked(
                    "hosts.create",
                    json!({"input":input("Late")}),
                    cancel,
                    Some(worker_fixture.origin.as_ref()),
                );
                finished
                    .send(result.as_ref().err().map(ToString::to_string))
                    .unwrap();
                result
            })
            .await
        });
        attempted(&f.origin).await;
        // Actual production authorization stays responsive while DB is held.
        f.security
            .authorize(
                &f.lease.id,
                &f.lease.fingerprint,
                &f.lease.permissions,
                Some("hosts.write"),
                None,
            )
            .unwrap();
        tokio::time::timeout(
            Duration::from_secs(1),
            tokio::time::sleep(Duration::from_millis(10)),
        )
        .await
        .unwrap();
        let expected = match reason {
            "retired" => {
                *f.origin.retired.lock().unwrap() = true;
                "origin.expired"
            }
            "revoked" => {
                f.security.remove_grant("editor");
                "pluginSecurity.approvalRequired"
            }
            _ => {
                caller.abort();
                "hosts.mutation.cancelled"
            }
        };
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(1), done)
                .await
                .unwrap()
                .unwrap()
                .as_deref(),
            Some(expected)
        );
        if reason == "cancelled" {
            assert!(caller.await.unwrap_err().is_cancelled());
        } else {
            assert_eq!(caller.await.unwrap().unwrap_err().to_string(), expected);
        }
        // The waiter has already exited, although the original DB owner still holds it.
        assert!(f.events.lock().unwrap().is_empty());
        drop(held);
        assert_eq!(f.state(), before);
    }
}

struct Fence(Arc<AtomicUsize>);
impl Drop for Fence {
    fn drop(&mut self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}
struct Publishing {
    recorder: Recorder,
    started: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
    release: Mutex<std::sync::mpsc::Receiver<()>>,
}
impl Effects for Publishing {
    fn renamed(&self, id: &str, name: &str) {
        self.recorder.renamed(id, name);
    }
    fn forget_credential(&self, id: &str) {
        self.recorder.forget_credential(id);
    }
    fn changed(&self) {
        self.started
            .lock()
            .unwrap()
            .take()
            .unwrap()
            .send(())
            .unwrap();
        self.release
            .lock()
            .unwrap()
            .recv_timeout(Duration::from_secs(5))
            .unwrap();
        self.recorder.changed();
    }
}

#[tokio::test]
async fn cancelled_delivery_after_commit_retains_actual_worker_fence_through_publication() {
    let f = Arc::new(Fixture::new("hosts.write"));
    let worker_fixture = f.clone();
    let retired = Arc::new(AtomicUsize::new(0));
    let (started, ready) = tokio::sync::oneshot::channel();
    let (release, wait) = std::sync::mpsc::channel();
    let (finished, done) = tokio::sync::oneshot::channel();
    let caller = tokio::spawn(WorkLifetime::new(Fence(retired.clone())).scope(async move {
        worker(move |cancel| {
            let f = worker_fixture;
            let service = test_service(
                &f.db,
                Publishing {
                    recorder: f.recorder(),
                    started: Mutex::new(Some(started)),
                    release: Mutex::new(wait),
                },
            )
            .admitted(Checked {
                db: &f.db,
                security: &f.security,
                lease: &f.lease,
                cancel,
                authority: Some(f.origin.as_ref()),
            });
            let result = execute(
                &service,
                "hosts.create",
                json!({"input":input("Committed")}),
            );
            finished.send(result.is_ok()).unwrap();
            result
        })
        .await
    }));
    ready.await.unwrap();
    // At the real postcommit effect: SQL+audit are committed and all original
    // authority/DB locks released, but the retained worker is not settled yet.
    assert_eq!(
        crate::services::hosts::snapshot(&f.db).unwrap().hosts.len(),
        1
    );
    assert_eq!(f.audit(), ["host.create"]);
    caller.abort();
    assert!(caller.await.unwrap_err().is_cancelled());
    assert_eq!(retired.load(Ordering::SeqCst), 0);
    assert!(f.events.lock().unwrap().is_empty());
    release.send(()).unwrap();
    assert!(tokio::time::timeout(Duration::from_secs(2), done)
        .await
        .unwrap()
        .unwrap());
    tokio::time::timeout(Duration::from_secs(2), async {
        while retired.load(Ordering::SeqCst) == 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(*f.events.lock().unwrap(), ["changed"]);
    assert_eq!(retired.load(Ordering::SeqCst), 1);
    assert_eq!(
        crate::services::hosts::snapshot(&f.db).unwrap().hosts.len(),
        1
    );
}
