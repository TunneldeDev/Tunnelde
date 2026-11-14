use super::*;
use crate::automation::{contract::Endpoint, transport::location};
use std::path::PathBuf;

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("tunnelde-api-life-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }

    fn register(&self) -> Registration {
        Registration::create(
            &self.0,
            &Endpoint {
                version: 1,
                address: "127.0.0.1:12345".parse().unwrap(),
                token: "a".repeat(64),
            },
        )
        .unwrap()
    }

    fn assert_clean(&self) {
        assert_eq!(std::fs::read_dir(&self.0).unwrap().count(), 0);
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn stopping_before_start_is_retained_and_idempotent() {
    let lifecycle = Lifecycle::default();
    lifecycle.stop();
    lifecycle.stop();
    assert!(lifecycle.begin().is_none());
    assert!(*lifecycle.stopped.subscribe().borrow());
}

#[test]
fn listener_ownership_unregisters_on_drop_and_cannot_restart() {
    let fixture = Fixture::new();
    let lifecycle = Lifecycle::default();
    let running = lifecycle.begin().unwrap();
    assert!(lifecycle.begin().is_none());
    assert!(running.register(fixture.register()));
    assert!(location::read(&fixture.0.join("automation.json")).is_ok());
    let stopped = running.shutdown();
    drop(running);
    assert!(*stopped.borrow());
    fixture.assert_clean();
    assert!(lifecycle.begin().is_none());
}

#[test]
fn stopping_during_startup_rejects_and_cleans_late_registration() {
    let fixture = Fixture::new();
    let lifecycle = Lifecycle::default();
    let running = lifecycle.begin().unwrap();
    lifecycle.stop();
    assert!(!running.register(fixture.register()));
    fixture.assert_clean();
    assert!(*running.shutdown().borrow());
}

#[test]
fn shutdown_unregisters_without_waiting_for_listener_poll() {
    let fixture = Fixture::new();
    let lifecycle = Lifecycle::default();
    let running = lifecycle.begin().unwrap();
    assert!(running.register(fixture.register()));
    lifecycle.stop();
    fixture.assert_clean();
    assert!(*running.shutdown().borrow());
    lifecycle.stop();
    drop(running);
    fixture.assert_clean();
}

#[test]
fn registration_racing_shutdown_never_survives_it() {
    let fixture = Fixture::new();
    let lifecycle = Lifecycle::default();
    let running = lifecycle.begin().unwrap();
    let registration = fixture.register();
    let barrier = std::sync::Barrier::new(2);
    std::thread::scope(|scope| {
        scope.spawn(|| {
            barrier.wait();
            lifecycle.stop();
        });
        barrier.wait();
        let _ = running.register(registration);
    });
    fixture.assert_clean();
    assert!(*running.shutdown().borrow());
}
