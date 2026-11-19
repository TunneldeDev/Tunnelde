use super::ownership::*;
use serde_json::json;
use std::time::{Duration, Instant};

struct Fixture {
    registry: Ownership,
    main: String,
    satellite: String,
    other: String,
    lease: Lease,
    now: Instant,
}
impl Fixture {
    fn new() -> Self {
        let mut registry = Ownership::default();
        let main = registry.register(MAIN).unwrap();
        let satellite = registry.register("panel-one").unwrap();
        let other = registry.register("panel-two").unwrap();
        for (window, doc) in [
            (MAIN, &main),
            ("panel-one", &satellite),
            ("panel-two", &other),
        ] {
            registry.ready(window, doc).unwrap();
        }
        let lease = registry.add_panel(MAIN, &main, "connections").unwrap();
        Self {
            registry,
            main,
            satellite,
            other,
            lease,
            now: Instant::now(),
        }
    }
    fn offer(&mut self) -> Offer {
        self.registry
            .prepare(
                MAIN,
                &self.main,
                &self.lease,
                "panel-one",
                json!({"draft": "memory-only", "scroll": 123}),
                self.now,
            )
            .unwrap()
    }
    fn move_to_satellite(&mut self) -> Lease {
        let offer = self.offer();
        self.registry
            .acknowledge("panel-one", &self.satellite, &offer.id, self.now)
            .unwrap();
        self.registry
            .commit(MAIN, &self.main, &offer.id, self.now)
            .unwrap()
    }
}
#[test]
fn transfers_are_prepare_ready_commit_with_exact_document_and_lease_fences() {
    let mut f = Fixture::new();
    let offer = f.offer();
    assert!(f.registry.action(MAIN, &f.main, &f.lease).is_err());
    assert_eq!(f.registry.leases(), vec![f.lease.clone()]);
    assert!(f.registry.commit(MAIN, &f.main, &offer.id, f.now).is_err());
    assert!(f
        .registry
        .staged("panel-two", &f.other, &offer.id, f.now)
        .is_err());
    assert!(f
        .registry
        .staged("panel-one", &f.main, &offer.id, f.now)
        .is_err());
    assert!(f
        .registry
        .staged("unregistered", &f.satellite, &offer.id, f.now)
        .is_err());
    let staged = f
        .registry
        .staged("panel-one", &f.satellite, &offer.id, f.now)
        .unwrap();
    assert_eq!(staged.offer.lease, f.lease);
    assert_eq!(staged.state, json!({"draft": "memory-only", "scroll": 123}));
    assert!(f
        .registry
        .checkpoint(MAIN, &f.main, &f.lease, 1, json!({}))
        .is_err());
    assert!(f
        .registry
        .prepare(MAIN, &f.main, &f.lease, "panel-two", json!({}), f.now)
        .is_err());
    f.registry
        .acknowledge("panel-one", &f.satellite, &offer.id, f.now)
        .unwrap();
    assert!(f
        .registry
        .commit("panel-one", &f.satellite, &offer.id, f.now)
        .is_err());
    let lease = f.registry.commit(MAIN, &f.main, &offer.id, f.now).unwrap();
    assert_eq!(lease.generation, f.lease.generation + 1);
    assert_eq!(lease.window_id, "panel-one");
    assert!(f.registry.action(MAIN, &f.main, &f.lease).is_err());
    assert!(f.registry.action("panel-two", &f.other, &lease).is_err());
    assert!(f.registry.action("panel-one", &f.satellite, &lease).is_ok());
    assert!(f.registry.commit(MAIN, &f.main, &offer.id, f.now).is_err());
    assert!(f.registry.view(MAIN, &f.main, &lease).is_err());
    assert_eq!(
        f.registry.view("panel-one", &f.satellite, &lease).unwrap()["draft"],
        "memory-only"
    );
    let public = serde_json::to_string(&(f.registry.windows(), f.registry.leases())).unwrap();
    assert!(!public.contains("memory-only"));
}
#[test]
fn cancellation_timeout_and_destination_reload_restore_source_authority() {
    for mode in ["cancel", "timeout", "reload", "close"] {
        let mut f = Fixture::new();
        let offer = f.offer();
        assert!(f.registry.cancel("panel-two", &f.other, &offer.id).is_err());
        match mode {
            "cancel" => f
                .registry
                .cancel("panel-one", &f.satellite, &offer.id)
                .unwrap(),
            "timeout" => {
                let later = f.now + Duration::from_secs(16);
                assert!(f
                    .registry
                    .staged("panel-one", &f.satellite, &offer.id, later)
                    .is_err());
                assert!(f
                    .registry
                    .acknowledge("panel-one", &f.satellite, &offer.id, later)
                    .is_err());
                assert_eq!(f.registry.expire(later), vec![offer.id.clone()]);
            }
            "reload" => {
                f.registry.register("panel-one").unwrap();
                assert!(f.registry.authorize("panel-one", &f.satellite).is_err());
            }
            _ => {
                assert!(f
                    .registry
                    .begin_close("panel-one", &f.satellite)
                    .unwrap()
                    .is_empty());
            }
        }
        assert!(f.registry.action(MAIN, &f.main, &f.lease).is_ok());
        assert_eq!(
            f.registry.view(MAIN, &f.main, &f.lease).unwrap(),
            json!(null)
        );
        assert!(f.registry.commit(MAIN, &f.main, &offer.id, f.now).is_err());
    }
}
#[test]
fn reloads_revoke_old_document_generations_without_stealing_other_window_views() {
    let mut f = Fixture::new();
    let lease = f.move_to_satellite();
    let fresh_main = f.registry.register(MAIN).unwrap();
    assert!(f.registry.authorize(MAIN, &f.main).is_err());
    assert_eq!(f.registry.leases(), vec![lease.clone()]);
    assert!(f.registry.action("panel-one", &f.satellite, &lease).is_ok());
    let fresh_sat = f.registry.register("panel-one").unwrap();
    assert!(f
        .registry
        .action("panel-one", &f.satellite, &lease)
        .is_err());
    assert!(f.registry.action("panel-one", &fresh_sat, &lease).is_err());
    let replacement = &f.registry.leases()[0];
    assert_eq!(replacement.generation, lease.generation + 1);
    assert!(f
        .registry
        .view("panel-one", &fresh_sat, replacement)
        .is_ok());
    assert!(f
        .registry
        .add_panel("panel-one", &fresh_sat, "tasks")
        .is_err());
    f.registry.add_panel(MAIN, &fresh_main, "tasks").unwrap();
}
#[test]
fn drags_are_opaque_bounded_single_use_and_do_not_transfer_authority() {
    let mut f = Fixture::new();
    let old = f
        .registry
        .issue_drag(MAIN, &f.main, &f.lease, f.now)
        .unwrap();
    let id = f
        .registry
        .issue_drag(MAIN, &f.main, &f.lease, f.now)
        .unwrap();
    assert!(uuid::Uuid::parse_str(&id).is_ok());
    assert_ne!(id, old);
    assert!(!id.contains("connections"));
    assert!(f
        .registry
        .accept_drag("panel-one", &f.satellite, &old, f.now)
        .is_err());
    assert!(f
        .registry
        .accept_drag("fake", &f.satellite, &id, f.now)
        .is_err());
    assert_eq!(
        f.registry
            .accept_drag("panel-one", &f.satellite, &id, f.now)
            .unwrap(),
        f.lease
    );
    assert!(f.registry.action(MAIN, &f.main, &f.lease).is_ok());
    assert!(f
        .registry
        .accept_drag("panel-one", &f.satellite, &id, f.now)
        .is_err());
    let id = f
        .registry
        .issue_drag(MAIN, &f.main, &f.lease, f.now)
        .unwrap();
    assert!(f
        .registry
        .accept_drag(
            "panel-one",
            &f.satellite,
            &id,
            f.now + Duration::from_secs(31)
        )
        .is_err());
    let id = f
        .registry
        .issue_drag(MAIN, &f.main, &f.lease, f.now)
        .unwrap();
    f.registry
        .block(MAIN, &f.main, &f.lease.panel_id, true)
        .unwrap();
    assert!(f
        .registry
        .accept_drag("panel-one", &f.satellite, &id, f.now)
        .is_err());
    assert!(f
        .registry
        .issue_drag(MAIN, &f.main, &f.lease, f.now)
        .is_err());
    assert!(f
        .registry
        .prepare(MAIN, &f.main, &f.lease, "panel-one", json!({}), f.now)
        .is_err());
}
#[test]
fn closing_returns_multiple_panels_to_hidden_main_without_disconnecting_resources() {
    let mut f = Fixture::new();
    let first = f.move_to_satellite();
    f.lease = f.registry.add_panel(MAIN, &f.main, "tasks").unwrap();
    let second = f.move_to_satellite();
    assert!(f.registry.has_satellites());
    assert!(!f.registry.can_destroy("panel-one"));
    assert!(f.registry.begin_close(MAIN, &f.main).is_err());
    let leases = f.registry.begin_close("panel-one", &f.satellite).unwrap();
    assert_eq!(leases.len(), 2);
    assert!(
        f.registry
            .windows()
            .iter()
            .find(|w| w.id == "panel-one")
            .unwrap()
            .closing
    );
    assert!(f
        .registry
        .action("panel-one", &f.satellite, &first)
        .is_err());
    for lease in [first, second] {
        let state = f.registry.view("panel-one", &f.satellite, &lease).unwrap();
        let offer = f
            .registry
            .prepare("panel-one", &f.satellite, &lease, MAIN, state, f.now)
            .unwrap();
        f.registry
            .acknowledge(MAIN, &f.main, &offer.id, f.now)
            .unwrap();
        f.registry.commit(MAIN, &f.main, &offer.id, f.now).unwrap();
    }
    assert!(f.registry.can_destroy("panel-one"));
    assert!(f.registry.destroyed("panel-one").unwrap().is_empty());
    assert_eq!(f.registry.leases().len(), 2);
    assert!(f
        .registry
        .leases()
        .iter()
        .all(|lease| lease.window_id == MAIN));
    f.registry.destroyed("panel-two").unwrap();
    assert!(!f.registry.has_satellites());
}
#[test]
fn failed_close_can_resume_and_authentication_guards_cancel_staged_transfers() {
    let mut f = Fixture::new();
    let lease = f.move_to_satellite();
    f.registry
        .block(MAIN, &f.main, "connections", true)
        .unwrap();
    assert!(f.registry.begin_close("panel-one", &f.satellite).is_err());
    assert!(
        !f.registry
            .windows()
            .iter()
            .find(|w| w.id == "panel-one")
            .unwrap()
            .closing
    );
    f.registry
        .block(MAIN, &f.main, "connections", false)
        .unwrap();
    f.registry.begin_close("panel-one", &f.satellite).unwrap();
    f.registry.cancel_close("panel-one", &f.satellite).unwrap();
    assert!(f.registry.action("panel-one", &f.satellite, &lease).is_ok());
    let offer = f
        .registry
        .prepare("panel-one", &f.satellite, &lease, MAIN, json!({}), f.now)
        .unwrap();
    f.registry
        .acknowledge(MAIN, &f.main, &offer.id, f.now)
        .unwrap();
    f.registry
        .block(MAIN, &f.main, "connections", true)
        .unwrap();
    assert!(f.registry.commit(MAIN, &f.main, &offer.id, f.now).is_err());
}
#[test]
fn crashed_source_recovers_latest_prepared_state_and_crashed_destination_never_steals() {
    let mut f = Fixture::new();
    let lease = f.move_to_satellite();
    f.registry
        .checkpoint(
            "panel-one",
            &f.satellite,
            &lease,
            1,
            json!({"draft": "checkpoint"}),
        )
        .unwrap();
    f.registry
        .prepare(
            "panel-one",
            &f.satellite,
            &lease,
            "panel-two",
            json!({"draft": "newer pending"}),
            f.now,
        )
        .unwrap();
    let recovered = f.registry.destroyed("panel-one").unwrap();
    assert_eq!(recovered.len(), 1);
    assert_eq!(recovered[0].generation, lease.generation + 1);
    assert_eq!(
        f.registry.view(MAIN, &f.main, &recovered[0]).unwrap()["draft"],
        "newer pending"
    );
    assert!(f
        .registry
        .action("panel-one", &f.satellite, &lease)
        .is_err());
    assert!(f.registry.destroyed(MAIN).is_err());
    f.lease = recovered[0].clone();
    let offer = f
        .registry
        .prepare(
            MAIN,
            &f.main,
            &f.lease,
            "panel-two",
            json!({"draft": "third"}),
            f.now,
        )
        .unwrap();
    f.registry.destroyed("panel-two").unwrap();
    assert!(f.registry.commit(MAIN, &f.main, &offer.id, f.now).is_err());
    assert!(f.registry.action(MAIN, &f.main, &f.lease).is_ok());
}
#[test]
fn permission_revocation_discards_view_and_every_pending_capability() {
    let mut f = Fixture::new();
    let grant = f
        .registry
        .issue_drag(MAIN, &f.main, &f.lease, f.now)
        .unwrap();
    let offer = f.offer();
    assert!(f
        .registry
        .remove_panel("panel-one", &f.satellite, "connections")
        .is_err());
    f.registry
        .remove_panel(MAIN, &f.main, "connections")
        .unwrap();
    assert!(f.registry.leases().is_empty());
    assert!(f.registry.commit(MAIN, &f.main, &offer.id, f.now).is_err());
    assert!(f
        .registry
        .accept_drag("panel-one", &f.satellite, &grant, f.now)
        .is_err());
    let replacement = f.registry.add_panel(MAIN, &f.main, "connections").unwrap();
    // A recreated contribution with the same semantic ID must never revive a
    // stale owner's authority. Test this explicitly below.
    assert_ne!(replacement, f.lease);
}
#[test]
fn unavailable_destinations_and_oversized_snapshots_do_not_freeze_or_move_views() {
    let mut f = Fixture::new();
    f.registry.register("not-ready").unwrap();
    let huge = json!({"draft": "x".repeat(1024 * 1024)});
    for target in [MAIN, "unknown", "not-ready"] {
        assert!(f
            .registry
            .prepare(MAIN, &f.main, &f.lease, target, json!({}), f.now)
            .is_err());
    }
    assert!(f
        .registry
        .prepare(MAIN, &f.main, &f.lease, "panel-one", huge.clone(), f.now)
        .is_err());
    assert!(f
        .registry
        .checkpoint(MAIN, &f.main, &f.lease, 1, huge)
        .is_err());
    assert!(f.registry.action(MAIN, &f.main, &f.lease).is_ok());
    assert!(f.registry.add_panel(MAIN, &f.main, "connections").is_err());
    for i in 0..200 {
        let _ = f.registry.register(&format!("sat-{i}"));
    }
    assert_eq!(f.registry.windows().len(), 16);
}

#[test]
fn reordered_checkpoints_cannot_replace_a_newer_draft_and_revision_resets_on_ownership_change() {
    let mut f = Fixture::new();
    f.registry
        .checkpoint(MAIN, &f.main, &f.lease, 2, json!({"draft": "newer"}))
        .unwrap();
    assert!(f
        .registry
        .checkpoint(MAIN, &f.main, &f.lease, 1, json!({"draft": "stale"}))
        .is_err());
    assert!(f
        .registry
        .checkpoint(MAIN, &f.main, &f.lease, 2, json!({"draft": "duplicate"}))
        .is_err());
    assert_eq!(
        f.registry.view(MAIN, &f.main, &f.lease).unwrap()["draft"],
        "newer"
    );
    let lease = f.move_to_satellite();
    assert!(f
        .registry
        .checkpoint(MAIN, &f.main, &f.lease, 3, json!({"draft": "late source"}))
        .is_err());
    f.registry
        .checkpoint(
            "panel-one",
            &f.satellite,
            &lease,
            1,
            json!({"draft": "new owner"}),
        )
        .unwrap();
    let offer = f
        .registry
        .prepare(
            "panel-one",
            &f.satellite,
            &lease,
            MAIN,
            json!({"draft": "reload capture"}),
            f.now,
        )
        .unwrap();
    let new_doc = f.registry.register("panel-one").unwrap();
    assert!(f.registry.commit(MAIN, &f.main, &offer.id, f.now).is_err());
    let current = &f.registry.leases()[0];
    assert_eq!(
        f.registry.view("panel-one", &new_doc, current).unwrap()["draft"],
        "reload capture"
    );
    f.registry
        .checkpoint(
            "panel-one",
            &new_doc,
            current,
            1,
            json!({"draft": "reloaded owner"}),
        )
        .unwrap();
}

#[test]
fn closing_cancels_inflight_moves_and_grants_and_only_accepts_return_to_coordinator() {
    let mut f = Fixture::new();
    let lease = f.move_to_satellite();
    let grant = f
        .registry
        .issue_drag("panel-one", &f.satellite, &lease, f.now)
        .unwrap();
    let offer = f
        .registry
        .prepare(
            "panel-one",
            &f.satellite,
            &lease,
            "panel-two",
            json!({"draft": "ready for close"}),
            f.now,
        )
        .unwrap();
    f.registry
        .acknowledge("panel-two", &f.other, &offer.id, f.now)
        .unwrap();
    f.registry.begin_close("panel-one", &f.satellite).unwrap();
    assert!(f.registry.commit(MAIN, &f.main, &offer.id, f.now).is_err());
    assert!(f
        .registry
        .accept_drag("panel-two", &f.other, &grant, f.now)
        .is_err());
    assert!(f
        .registry
        .prepare(
            "panel-one",
            &f.satellite,
            &lease,
            "panel-two",
            json!({}),
            f.now
        )
        .is_err());
    assert_eq!(
        f.registry.view("panel-one", &f.satellite, &lease).unwrap()["draft"],
        "ready for close"
    );
    let returning = f
        .registry
        .prepare("panel-one", &f.satellite, &lease, MAIN, json!({}), f.now)
        .unwrap();
    f.registry
        .acknowledge(MAIN, &f.main, &returning.id, f.now)
        .unwrap();
    f.registry.cancel_close("panel-one", &f.satellite).unwrap();
    assert!(f
        .registry
        .commit(MAIN, &f.main, &returning.id, f.now)
        .is_err());
    assert!(f.registry.action("panel-one", &f.satellite, &lease).is_ok());
}

#[test]
fn pointer_drag_release_and_cancel_require_the_exact_source_and_are_single_use() {
    let mut f = Fixture::new();
    let id = f
        .registry
        .issue_drag(MAIN, &f.main, &f.lease, f.now)
        .unwrap();
    assert!(f
        .registry
        .release_drag("panel-one", &f.satellite, &id, f.now)
        .is_err());
    assert!(f
        .registry
        .cancel_drag("panel-one", &f.satellite, &id)
        .is_err());
    assert!(f.registry.release_drag(MAIN, &f.other, &id, f.now).is_err());
    assert_eq!(
        f.registry.release_drag(MAIN, &f.main, &id, f.now).unwrap(),
        f.lease
    );
    assert!(f.registry.release_drag(MAIN, &f.main, &id, f.now).is_err());
    assert!(f.registry.action(MAIN, &f.main, &f.lease).is_ok()); // No implicit transfer.
    let id = f
        .registry
        .issue_drag(MAIN, &f.main, &f.lease, f.now)
        .unwrap();
    f.registry.cancel_drag(MAIN, &f.main, &id).unwrap();
    assert!(f.registry.release_drag(MAIN, &f.main, &id, f.now).is_err());
    let id = f
        .registry
        .issue_drag(MAIN, &f.main, &f.lease, f.now)
        .unwrap();
    assert!(f
        .registry
        .release_drag(MAIN, &f.main, &id, f.now + Duration::from_secs(31))
        .is_err());
}
#[test]
fn drag_release_rechecks_blocking_actions_reload_and_transfer_incarnations() {
    let mut f = Fixture::new();
    let id = f
        .registry
        .issue_drag(MAIN, &f.main, &f.lease, f.now)
        .unwrap();
    let action = f
        .registry
        .begin_native_action(MAIN, &f.main, &f.lease)
        .unwrap();
    assert!(f.registry.release_drag(MAIN, &f.main, &id, f.now).is_err());
    f.registry.finish_native_action("connections", &action);
    f.registry.cancel_drag(MAIN, &f.main, &id).unwrap();
    let id = f
        .registry
        .issue_drag(MAIN, &f.main, &f.lease, f.now)
        .unwrap();
    f.registry
        .block(MAIN, &f.main, "connections", true)
        .unwrap();
    assert!(f.registry.release_drag(MAIN, &f.main, &id, f.now).is_err());
    f.registry
        .block(MAIN, &f.main, "connections", false)
        .unwrap();
    let id = f
        .registry
        .issue_drag(MAIN, &f.main, &f.lease, f.now)
        .unwrap();
    let lease = f.move_to_satellite();
    assert!(f.registry.release_drag(MAIN, &f.main, &id, f.now).is_err());
    let id = f
        .registry
        .issue_drag("panel-one", &f.satellite, &lease, f.now)
        .unwrap();
    let next = f.registry.register("panel-one").unwrap();
    f.registry.ready("panel-one", &next).unwrap();
    assert!(f
        .registry
        .release_drag("panel-one", &f.satellite, &id, f.now)
        .is_err());
    assert!(f
        .registry
        .release_drag("panel-one", &next, &id, f.now)
        .is_err());
}
