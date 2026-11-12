use super::*;
use std::sync::Condvar;

#[derive(Clone, Default)]
struct Slow {
    started: Arc<std::sync::atomic::AtomicUsize>,
    release: Arc<(Mutex<bool>, Condvar)>,
    values: MemorySecrets,
}
impl Secrets for Slow {
    fn create(&self, key: &str, token: &str) -> journal::Result<()> {
        self.started.fetch_add(1, Ordering::AcqRel);
        let (lock, wake) = &*self.release;
        let mut released = lock.lock().unwrap();
        while !*released {
            released = wake.wait(released).unwrap();
        }
        self.values.create(key, token)
    }
    fn load(&self, key: &str) -> journal::Result<String> {
        self.values.load(key)
    }
    fn forget(&self, key: &str, expected: &str) -> journal::Result<()> {
        self.values.forget(key, expected)
    }
}
struct Wake(Slow);
impl Drop for Wake {
    fn drop(&mut self) {
        *self.0.release.0.lock().unwrap() = true;
        self.0.release.1.notify_all();
    }
}
#[tokio::test(flavor = "current_thread")]
async fn slow_keyring_io_does_not_block_async_executor_and_aborted_callers_retain_actual_slots() {
    let fixture = Fixture::new();
    let slow = Slow::default();
    let wake = Wake(slow.clone());
    let service = Arc::new(Service::new(
        Journal::create(&fixture.path()).unwrap(),
        slow.clone(),
    ));
    let authority = authority();
    let mut callers = Vec::new();
    for index in 0..4 {
        let service = service.clone();
        let authority = authority.clone();
        callers.push(tokio::spawn(async move {
            let prepared = crate::ssh::files::native_save::contracts::operation::Prepared::new(
                &authority,
                vec![format!("blocked-{index}")],
                crate::ssh::files::native_save::contracts::operation::Baseline::Absent,
                "test".into(),
            )
            .unwrap();
            service
                .reserve(binding(&authority, &prepared), &prepared)
                .await
        }));
    }
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while slow.started.load(Ordering::Acquire) != 1 || service.io.available_permits() != 0 {
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    for caller in callers {
        caller.abort();
        let _ = caller.await;
    }
    assert!(matches!(
        service.records().await,
        Err(journal::Error::Capacity)
    ));
    drop(wake);
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while service.io.available_permits() != 4 {
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    let records = service.records().await.unwrap();
    assert_eq!(records.len(), 4);
    for record in records {
        assert!(record.stage == Stage::Ready);
        service.finalize(&record).await.unwrap();
    }
}
