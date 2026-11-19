//! Native multiwindow control plane and generation-fenced view ownership.
mod actions;
mod geometry;
pub(crate) mod native;
mod ownership;
mod protocol;
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
