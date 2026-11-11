use super::*;
use std::sync::atomic::{AtomicBool, Ordering};

#[tokio::test]
async fn cancellation_is_owned_and_drops_work_before_reply() {
    let registry = Requests::default();
    registry.reserve("a", "1").unwrap();
    registry.reserve("b", "1").unwrap();
    let mut request = registry.claim("a", "1").unwrap();
    assert!(registry.claim("a", "1").is_err());
    assert!(!registry.cancel("other", "1"));
    let dropped = AtomicBool::new(false);
    struct Dropped<'a>(&'a AtomicBool);
    impl Drop for Dropped<'_> {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }
    let marker = Dropped(&dropped);
    let work = async move {
        let _marker = marker;
        std::future::pending::<AppResult<()>>().await
    };
    assert!(registry.cancel("a", "1"));
    assert_eq!(
        request.run(work).await.unwrap_err().to_string(),
        "plugin.api.cancelled"
    );
    assert!(dropped.load(Ordering::SeqCst));
    assert!(registry.claim("b", "1").is_ok());
}

#[test]
fn duplicate_replay_late_drop_and_owner_retirement_are_fenced() {
    let registry = Requests::default();
    registry.reserve("a", "1").unwrap();
    assert!(registry.reserve("a", "1").is_err());
    let old = registry.claim("a", "1").unwrap();
    registry.cancel("a", "1");
    assert!(registry.reserve("a", "1").is_err());
    registry.retire("a");
    registry.reserve("a", "1").unwrap();
    drop(old);
    assert!(registry.claim("a", "1").is_ok());
    registry.reserve("a", "pending").unwrap();
    registry.reserve("b", "pending").unwrap();
    registry.retire("a");
    assert!(registry.claim("a", "pending").is_err());
    assert!(registry.claim("b", "pending").is_ok());
}

#[test]
fn quotas_expiration_and_abandoned_reservations_are_bounded() {
    let registry = Requests::default();
    for owner in ["a", "b"] {
        for id in 0..32 {
            registry.reserve(owner, &id.to_string()).unwrap();
        }
    }
    assert!(registry.reserve("a", "overflow").is_err());
    assert!(registry.reserve("c", "overflow").is_err());
    for entry in registry.inner.lock().unwrap().values() {
        entry.lock().unwrap().deadline = Instant::now();
    }
    assert!(registry.claim("a", "0").is_err());
    registry.reserve("c", "new").unwrap();
    assert_eq!(registry.inner.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn already_completed_effects_are_not_rolled_back_by_cancel() {
    let registry = Requests::default();
    registry.reserve("a", "1").unwrap();
    let mut request = registry.claim("a", "1").unwrap();
    assert_eq!(request.run(async { Ok(42) }).await.unwrap(), 42);
    drop(request);
    assert!(!registry.cancel("a", "1"));
}
