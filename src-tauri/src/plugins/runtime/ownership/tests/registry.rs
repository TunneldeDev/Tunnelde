use super::{Registry, Scope};
use crate::plugins::security::Lease;

fn lease(owner: &str, generation: u64) -> Lease {
    Lease {
        id: owner.into(),
        generation,
        fingerprint: "a".repeat(64),
        permissions: vec![],
    }
}

#[test]
fn pending_and_live_resources_share_bounded_budgets() {
    let registry = Registry::new(2, 3);
    let pending = registry.reserve(lease("one", 1), None).unwrap();
    registry
        .reserve(lease("one", 1), None)
        .unwrap()
        .commit("live")
        .unwrap();
    assert!(registry.reserve(lease("one", 2), None).is_err());
    let other = registry.reserve(lease("two", 1), None).unwrap();
    assert!(registry.reserve(lease("three", 1), None).is_err());
    drop(pending);
    let replacement = registry.reserve(lease("one", 2), None).unwrap();
    drop(other);
    drop(replacement);
    registry.forget(|value| value == &"live");
    assert!(registry.entries.lock().unwrap().is_empty());
}

#[test]
fn cleanup_rejects_late_completion_without_touching_new_generation_or_other_owner() {
    let registry = Registry::new(8, 64);
    let pending = registry.reserve(lease("one", 1), None).unwrap();
    registry
        .reserve(lease("one", 1), None)
        .unwrap()
        .commit("old")
        .unwrap();
    registry
        .reserve(lease("one", 2), None)
        .unwrap()
        .commit("new")
        .unwrap();
    registry
        .reserve(lease("two", 1), None)
        .unwrap()
        .commit("other")
        .unwrap();
    assert_eq!(registry.remove_runtime("one", |g| g < 2), ["old"]);
    assert_eq!(pending.commit("late"), Err("late"));
    assert!(registry.remove_runtime("one", |g| g == 1).is_empty());
    assert_eq!(registry.remove_runtime("one", |g| g == 2), ["new"]);
    assert_eq!(registry.remove_runtime("two", |_| true), ["other"]);
}

#[test]
fn cancelled_reservation_cannot_remove_a_later_reservation() {
    let registry = Registry::<String>::new(1, 1);
    let old = registry.reserve(lease("one", 1), None).unwrap();
    registry.remove_runtime("one", |_| true);
    let new = registry.reserve(lease("one", 2), None).unwrap();
    drop(old);
    new.commit("new".into()).unwrap();
    assert_eq!(registry.remove_runtime("one", |_| true), ["new"]);
}

fn scope(client: &str, request: uuid::Uuid) -> Option<Scope> {
    Some(Scope {
        client: client.into(),
        request,
    })
}

#[test]
fn client_cleanup_releases_pending_and_live_without_crossing_ownership_boundaries() {
    let registry = Registry::new(8, 16);
    let request = uuid::Uuid::new_v4();
    let pending = registry
        .reserve(lease("one", 1), scope("a", request))
        .unwrap();
    for (owner, generation, client, value) in [
        ("one", 1, Some("a"), "revoked"),
        ("one", 1, Some("b"), "other-client"),
        ("one", 1, None, "direct-plugin"),
        ("one", 2, Some("a"), "replacement"),
        ("two", 1, Some("a"), "other-plugin"),
    ] {
        registry
            .reserve(
                lease(owner, generation),
                client.and_then(|c| scope(c, request)),
            )
            .unwrap()
            .commit(value)
            .unwrap();
    }
    assert_eq!(registry.remove_client("one", 1, "a"), ["revoked"]);
    assert_eq!(pending.commit("late"), Err("late"));
    assert!(registry.remove_client("one", 1, "a").is_empty());
    assert_eq!(registry.remove_client("one", 1, "b"), ["other-client"]);
    assert_eq!(registry.remove_client("one", 2, "a"), ["replacement"]);
    assert_eq!(registry.remove_client("two", 1, "a"), ["other-plugin"]);
    assert_eq!(registry.remove_runtime("one", |_| true), ["direct-plugin"]);
}

#[test]
fn abandoned_request_cleanup_cannot_remove_a_reused_public_request_id() {
    let registry = Registry::new(8, 16);
    let old = uuid::Uuid::new_v4();
    let replacement = uuid::Uuid::new_v4();
    let pending = registry.reserve(lease("one", 1), scope("a", old)).unwrap();
    registry
        .reserve(lease("one", 1), scope("a", old))
        .unwrap()
        .commit("old-live")
        .unwrap();
    registry
        .reserve(lease("one", 1), scope("a", replacement))
        .unwrap()
        .commit("new-live")
        .unwrap();
    registry
        .reserve(lease("one", 2), scope("a", old))
        .unwrap()
        .commit("new-runtime")
        .unwrap();
    registry
        .reserve(lease("two", 1), scope("a", old))
        .unwrap()
        .commit("other-plugin")
        .unwrap();
    assert_eq!(registry.remove_request("one", 1, old), ["old-live"]);
    assert_eq!(pending.commit("late"), Err("late"));
    assert!(registry.remove_request("one", 1, old).is_empty());
    assert_eq!(registry.remove_request("one", 1, replacement), ["new-live"]);
    assert_eq!(registry.remove_request("one", 2, old), ["new-runtime"]);
    assert_eq!(registry.remove_request("two", 1, old), ["other-plugin"]);
}

#[test]
fn revoked_pending_reservations_release_capacity_before_their_futures_finish() {
    let registry = Registry::<&str>::new(1, 1);
    let request = uuid::Uuid::new_v4();
    let old = registry
        .reserve(lease("one", 1), scope("a", request))
        .unwrap();
    assert!(registry
        .reserve(lease("one", 1), scope("b", request))
        .is_err());
    registry.remove_client("one", 1, "a");
    let new = registry
        .reserve(lease("one", 1), scope("b", request))
        .unwrap();
    drop(old);
    new.commit("new").unwrap();
    assert_eq!(registry.remove_client("one", 1, "b"), ["new"]);
}

#[test]
fn handoff_requires_exact_live_owner_and_accepted_result_and_releases_quota() {
    let registry = Registry::new(1, 1);
    let request = uuid::Uuid::new_v4();
    let pending = registry
        .reserve(lease("one", 1), scope("agent", request))
        .unwrap();
    assert!(registry.ownership("one", 1, |_| true).is_none());
    pending.commit("session").unwrap();
    let receipt = registry.ownership("one", 1, |_| true).unwrap();
    assert!(!receipt.accepted);
    assert!(registry.handoff("one", 1, &receipt).is_none());
    registry.accept_request("other", 1, request);
    registry.accept_request("one", 2, request);
    assert!(!registry.ownership("one", 1, |_| true).unwrap().accepted);
    registry.accept_request("one", 1, request);
    let receipt = registry.ownership("one", 1, |_| true).unwrap();
    assert!(receipt.accepted);
    assert!(registry.handoff("other", 1, &receipt).is_none());
    assert!(registry.handoff("one", 2, &receipt).is_none());
    assert_eq!(registry.handoff("one", 1, &receipt), Some("session"));
    assert!(registry.remove_client("one", 1, "agent").is_empty());
    assert!(registry.remove_request("one", 1, request).is_empty());
    assert!(registry.remove_runtime("one", |_| true).is_empty());
    let replacement = registry.reserve(lease("one", 1), None).unwrap();
    replacement.commit("session").unwrap();
    assert!(registry.handoff("one", 1, &receipt).is_none());
    assert_eq!(registry.remove_runtime("one", |_| true), ["session"]);
}

#[test]
fn stale_consent_cannot_adopt_a_revoked_or_replaced_resource() {
    let registry = Registry::new(8, 64);
    registry
        .reserve(lease("one", 1), None)
        .unwrap()
        .commit("old")
        .unwrap();
    let receipt = registry
        .ownership("one", 1, |value| value == &"old")
        .unwrap();
    assert!(receipt.accepted);
    assert_eq!(registry.remove_runtime("one", |_| true), ["old"]);
    registry
        .reserve(lease("one", 2), None)
        .unwrap()
        .commit("old")
        .unwrap();
    assert!(registry.handoff("one", 2, &receipt).is_none());
    assert_eq!(registry.remove_runtime("one", |_| true), ["old"]);
}

#[test]
fn handoff_and_runtime_cleanup_have_only_one_winner() {
    for _ in 0..64 {
        let registry = Registry::new(8, 64);
        registry
            .reserve(lease("one", 1), None)
            .unwrap()
            .commit("session")
            .unwrap();
        let receipt = registry.ownership("one", 1, |_| true).unwrap();
        let barrier = std::sync::Barrier::new(2);
        std::thread::scope(|threads| {
            let worker = threads.spawn(|| {
                barrier.wait();
                registry.handoff("one", 1, &receipt)
            });
            barrier.wait();
            let closed = registry.remove_runtime("one", |_| true);
            let adopted = worker.join().unwrap();
            assert_eq!(closed.len() + usize::from(adopted.is_some()), 1);
        });
    }
}

#[test]
fn observation_excludes_pending_foreign_old_and_handed_off_resources() {
    let registry = Registry::new(8, 32);
    let request = uuid::Uuid::new_v4();
    let pending = registry.reserve(lease("owner", 1), None).unwrap();
    registry
        .reserve(lease("owner", 1), scope("client", request))
        .unwrap()
        .commit("awaiting-acceptance")
        .unwrap();
    registry
        .reserve(lease("foreign", 1), None)
        .unwrap()
        .commit("foreign")
        .unwrap();
    registry
        .reserve(lease("owner", 2), None)
        .unwrap()
        .commit("other-generation")
        .unwrap();
    assert!(registry.owned("owner", 1).is_empty());
    registry.accept_request("owner", 1, request);
    let observed = registry.owned("owner", 1);
    assert_eq!(observed.len(), 1);
    assert_eq!(observed[0].1, "awaiting-acceptance");
    let token = observed[0].0.clone();
    assert!(registry.handoff("owner", 2, &token).is_none());
    assert_eq!(
        registry.handoff("owner", 1, &token),
        Some("awaiting-acceptance")
    );
    assert!(registry.owned("owner", 1).is_empty());
    assert!(registry.handoff("owner", 1, &token).is_none());
    pending.commit("late").unwrap();
    let replacement = registry.owned("owner", 1);
    assert_ne!(replacement[0].0.identity(), token.identity());
}
