//! Native multiwindow control plane and generation-fenced view ownership.
mod actions;
mod geometry;
mod lifecycle;
mod moves;
pub(crate) mod native;
mod ownership;
pub(crate) mod plugin_views;
mod presentation;
mod presentation_jobs;
mod protocol;
pub(crate) mod public;
pub(crate) mod public_moves;
pub(crate) mod public_panels;
mod read_models;
#[cfg(test)]
mod tests;

#[cfg(test)]
mod destination_tests {
    use super::ownership::Ownership;
    use serde_json::Value;
    use std::time::Instant;
    #[test]
    fn satellite_destination_creation_requires_an_interactive_exact_adapter_lease() {
        let mut registry = Ownership::default();
        let main = registry.register("main").unwrap();
        let source = registry.register("source").unwrap();
        let other = registry.register("other").unwrap();
        for (window, document) in [("main", &main), ("source", &source), ("other", &other)] {
            registry.ready(window, document).unwrap();
        }
        let initial = registry.add_panel("main", &main, "tasks").unwrap();
        assert!(registry.authorize_creation("main", &main, None).is_ok());
        assert!(registry
            .authorize_creation("source", &source, None)
            .is_err());
        assert!(registry
            .authorize_creation("source", &source, Some(&initial))
            .is_err());
        let now = Instant::now();
        let offer = registry
            .prepare("main", &main, &initial, "source", Value::Null, now)
            .unwrap();
        registry
            .acknowledge("source", &source, &offer.id, now)
            .unwrap();
        let lease = registry.commit("main", &main, &offer.id, now).unwrap();
        assert!(registry
            .authorize_creation("source", &source, Some(&lease))
            .is_ok());
        registry.block("main", &main, "tasks", true).unwrap();
        assert!(registry
            .authorize_creation("source", &source, Some(&lease))
            .is_err());
        registry.block("main", &main, "tasks", false).unwrap();
        let action = registry
            .request_action(
                "source",
                &source,
                &lease,
                super::actions::ViewAction::ClearTasks {},
                now,
            )
            .unwrap();
        assert!(registry
            .authorize_creation("source", &source, Some(&lease))
            .is_err());
        registry.cancel_action("source", &source, &action).unwrap();
        assert!(registry
            .authorize_creation("source", &source, Some(&lease))
            .is_ok());
        let offer = registry
            .prepare("source", &source, &lease, "other", Value::Null, now)
            .unwrap();
        assert!(registry
            .authorize_creation("source", &source, Some(&lease))
            .is_err());
        registry.cancel("source", &source, &offer.id).unwrap();
        registry.register("source").unwrap();
        assert!(registry
            .authorize_creation("source", &source, Some(&lease))
            .is_err());
    }
    #[test]
    fn empty_destruction_reservation_prevents_a_new_handoff_racing_native_destroy() {
        let mut registry = Ownership::default();
        let main = registry.register("main").unwrap();
        let target = registry.register("target").unwrap();
        registry.ready("main", &main).unwrap();
        registry.ready("target", &target).unwrap();
        let lease = registry.add_panel("main", &main, "connections").unwrap();
        assert!(registry.reserve_empty_close("main").is_err());
        assert!(registry.reserve_empty_close("unknown").is_err());
        let now = Instant::now();
        let offer = registry
            .prepare("main", &main, &lease, "target", Value::Null, now)
            .unwrap();
        assert!(registry.reserve_empty_close("target").is_err());
        registry.cancel("main", &main, &offer.id).unwrap();
        assert_eq!(registry.reserve_empty_close("target").unwrap(), target);
        assert!(registry
            .prepare("main", &main, &lease, "target", Value::Null, now)
            .is_err());
        // Frontend cancellation/reload cannot reopen a native destroy reservation.
        registry.cancel_close("target", &target).unwrap();
        assert!(registry
            .prepare("main", &main, &lease, "target", Value::Null, now)
            .is_err());
        let reloaded = registry.register("target").unwrap();
        registry.ready("target", &reloaded).unwrap();
        assert!(registry
            .prepare("main", &main, &lease, "target", Value::Null, now)
            .is_err());
        registry.release_empty_close("target");
        assert!(registry
            .prepare("main", &main, &lease, "target", Value::Null, now)
            .is_ok());
    }
}

#[cfg(test)]
mod interaction_tests {
    use super::{actions::ViewAction, ownership::Ownership};
    use serde_json::{json, Value};
    use std::time::Instant;
    #[test]
    fn independently_owned_consent_guards_block_migration_not_the_confirmed_action() {
        let mut r = Ownership::default();
        let main = r.register("main").unwrap();
        let source = r.register("source").unwrap();
        let other = r.register("other").unwrap();
        for (w, d) in [("main", &main), ("source", &source), ("other", &other)] {
            r.ready(w, d).unwrap();
        }
        let initial = r.add_panel("main", &main, "knownHosts").unwrap();
        let now = Instant::now();
        let offer = r
            .prepare("main", &main, &initial, "source", Value::Null, now)
            .unwrap();
        assert!(r.begin_interaction("main", &main, &initial).is_err());
        r.acknowledge("source", &source, &offer.id, now).unwrap();
        let lease = r.commit("main", &main, &offer.id, now).unwrap();
        assert!(r.begin_interaction("main", &main, &initial).is_err());
        assert!(r.begin_interaction("other", &other, &lease).is_err());
        let drag = r.issue_drag("source", &source, &lease, now).unwrap();
        let first = r.begin_interaction("source", &source, &lease).unwrap();
        let second = r.begin_interaction("source", &source, &lease).unwrap();
        assert!(r.release_drag("source", &source, &drag, now).is_err());
        assert!(r.issue_drag("source", &source, &lease, now).is_err());
        assert!(r.begin_close("source", &source).is_err());
        assert!(r
            .authorize_creation("source", &source, Some(&lease))
            .is_err());
        assert!(r
            .prepare("source", &source, &lease, "other", Value::Null, now)
            .is_err());
        assert!(r.end_interaction("other", &other, &lease, &first).is_err());
        r.end_interaction("source", &source, &lease, &first)
            .unwrap();
        r.end_interaction("source", &source, &lease, &first)
            .unwrap();
        r.block("main", &main, "knownHosts", false).unwrap();
        assert!(r
            .prepare("source", &source, &lease, "other", Value::Null, now)
            .is_err());
        let id = r
            .request_action(
                "source",
                &source,
                &lease,
                ViewAction::RefreshKnownHosts {},
                now,
            )
            .unwrap();
        let snapshot = r
            .dispatch("other", &other, super::protocol::Command::Snapshot {}, now)
            .unwrap();
        assert!(!snapshot.to_string().contains(&second));
        r.end_interaction("source", &source, &lease, &second)
            .unwrap();
        // Resource fence still applies independently of the dismissed consent.
        assert!(r
            .prepare("source", &source, &lease, "other", Value::Null, now)
            .is_err());
        r.cancel_action("source", &source, &id).unwrap();
        r.prepare("source", &source, &lease, "other", Value::Null, now)
            .unwrap();
    }
    #[test]
    fn reload_and_crash_retire_only_document_local_consent_and_limit_live_guards() {
        let mut r = Ownership::default();
        let main = r.register("main").unwrap();
        let source = r.register("source").unwrap();
        r.ready("main", &main).unwrap();
        r.ready("source", &source).unwrap();
        let lease = r.add_panel("main", &main, "knownHosts").unwrap();
        let old = r.begin_interaction("main", &main, &lease).unwrap();
        for _ in 1..16 {
            r.begin_interaction("main", &main, &lease).unwrap();
        }
        assert!(r.begin_interaction("main", &main, &lease).is_err());
        let new_main = r.register("main").unwrap();
        r.ready("main", &new_main).unwrap();
        let lease = r.leases().remove(0);
        assert!(r.end_interaction("main", &main, &lease, &old).is_err());
        let now = Instant::now();
        let offer = r
            .prepare("main", &new_main, &lease, "source", json!({}), now)
            .unwrap();
        r.acknowledge("source", &source, &offer.id, now).unwrap();
        let lease = r.commit("main", &new_main, &offer.id, now).unwrap();
        r.begin_interaction("source", &source, &lease).unwrap();
        let recovered = r.destroyed("source").unwrap().remove(0);
        assert!(r
            .authorize_creation("main", &new_main, Some(&recovered))
            .is_ok());
    }
}
