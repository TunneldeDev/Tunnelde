//! Private, in-memory view projections. The coordinator publishes data; only
//! the current owner or the staged destination may read it. Events are hints,
//! never data envelopes. This is not a plugin bus or an arbitrary invoke proxy.
use super::ownership::{Lease, Ownership};
use serde_json::Value;

impl Ownership {
    pub fn begin_model(
        &mut self,
        window: &str,
        document: &str,
        panel_id: &str,
    ) -> Result<String, &'static str> {
        self.main(window, document)?;
        let panel = self.panels.get_mut(panel_id).ok_or("panel not found")?;
        panel.model_document = document.into();
        panel.model_publisher = uuid::Uuid::new_v4().to_string();
        panel.model_revision = 0;
        Ok(panel.model_publisher.clone())
    }
    pub fn publish_model(
        &mut self,
        window: &str,
        document: &str,
        panel_id: &str,
        publisher: &str,
        revision: u64,
        model: Value,
    ) -> Result<(), &'static str> {
        self.main(window, document)?;
        // Output retains bounded UTF-8 entries plus JSON row metadata. View
        // draft capsules keep their separate stricter 1 MiB limit.
        // A decoded preview is <=2MiB UTF-8, but JSON escaping can
        // expand each byte sixfold. This is not a view draft/capsule.
        let limit = if self.editor_page_registered(panel_id) {
            // At most two 2MiB UTF-8 buffers with worst-case JSON escaping.
            32 * 1024 * 1024
        } else if panel_id == "filePreview" {
            16 * 1024 * 1024
        } else if panel_id == "output" {
            2 * 1024 * 1024
        } else {
            1024 * 1024
        };
        if serde_json::to_vec(&model)
            .map_err(|_| "invalid read model")?
            .len()
            > limit
        {
            return Err("read model too large");
        }
        let panel = self.panels.get_mut(panel_id).ok_or("panel not found")?;
        if panel.model_document != document
            || panel.model_publisher != publisher
            || revision <= panel.model_revision
        {
            return Err("stale read model");
        }
        panel.model_revision = revision;
        panel.model = model;
        Ok(())
    }
    pub fn read_model(
        &self,
        window: &str,
        document: &str,
        lease: &Lease,
    ) -> Result<Value, &'static str> {
        Ok(self.owned(window, document, lease)?.model.clone())
    }
    pub fn staged_model(
        &self,
        window: &str,
        document: &str,
        id: &str,
        now: std::time::Instant,
    ) -> Result<Value, &'static str> {
        let staged = self.staged(window, document, id, now)?;
        Ok(self.panels[&staged.offer.lease.panel_id].model.clone())
    }
    /// A resource action may outlive its initiating component. Keep the panel
    /// immovable until native cleanup finishes, even if that document reloads.
    pub fn begin_native_action(
        &mut self,
        window: &str,
        document: &str,
        lease: &Lease,
    ) -> Result<String, &'static str> {
        self.action(window, document, lease)?;
        if lease.panel_id != "connections" {
            return Err("unsupported panel action");
        }
        let panel = self.panels.get_mut(&lease.panel_id).unwrap();
        if !panel.native_actions.is_empty() {
            return Err("panel action in progress");
        }
        let id = uuid::Uuid::new_v4().to_string();
        panel.native_actions.insert(id.clone());
        Ok(id)
    }
    pub fn finish_native_action(&mut self, panel_id: &str, id: &str) {
        if let Some(panel) = self.panels.get_mut(panel_id) {
            panel.native_actions.remove(id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::time::Instant;

    #[test]
    fn projections_are_scoped_revisioned_bounded_and_never_in_metadata() {
        let mut registry = Ownership::default();
        let main = registry.register("main").unwrap();
        let target = registry.register("target").unwrap();
        let other = registry.register("other").unwrap();
        for (window, document) in [("main", &main), ("target", &target), ("other", &other)] {
            registry.ready(window, document).unwrap();
        }
        let lease = registry.add_panel("main", &main, "connections").unwrap();
        let publisher = registry.begin_model("main", &main, "connections").unwrap();
        let model = json!({"sessions":["private-address"]});
        registry
            .publish_model("main", &main, "connections", &publisher, 1, model.clone())
            .unwrap();
        assert!(registry
            .publish_model("target", &target, "connections", &publisher, 2, json!({}))
            .is_err());
        assert!(registry
            .publish_model("main", &main, "connections", &publisher, 1, json!({}))
            .is_err());
        assert!(registry
            .publish_model(
                "main",
                &main,
                "connections",
                &publisher,
                2,
                json!("x".repeat(1024 * 1024))
            )
            .is_err());
        assert_eq!(registry.read_model("main", &main, &lease).unwrap(), model);
        assert!(registry.read_model("other", &other, &lease).is_err());
        let now = Instant::now();
        let offer = registry
            .prepare("main", &main, &lease, "target", json!({}), now)
            .unwrap();
        assert_eq!(
            registry
                .staged_model("target", &target, &offer.id, now)
                .unwrap(),
            model
        );
        assert!(registry
            .staged_model("other", &other, &offer.id, now)
            .is_err());
        let snapshot = registry
            .dispatch(
                "other",
                &other,
                super::super::protocol::Command::Snapshot {},
                now,
            )
            .unwrap();
        assert!(!snapshot.to_string().contains("private-address"));
        registry
            .acknowledge("target", &target, &offer.id, now)
            .unwrap();
        let moved = registry.commit("main", &main, &offer.id, now).unwrap();
        assert!(registry.read_model("main", &main, &lease).is_err());
        assert_eq!(
            registry.read_model("target", &target, &moved).unwrap(),
            model
        );
        registry.register("target").unwrap();
        assert!(registry.read_model("target", &target, &moved).is_err());
    }
    #[test]
    fn removal_preserves_direct_native_cleanup_fences_across_main_reload() {
        let mut registry = Ownership::default();
        let main = registry.register("main").unwrap();
        registry.ready("main", &main).unwrap();
        let lease = registry.add_panel("main", &main, "connections").unwrap();
        let id = registry.begin_native_action("main", &main, &lease).unwrap();
        assert!(registry.remove_panel("main", &main, "connections").is_err());
        let main = registry.register("main").unwrap();
        registry.ready("main", &main).unwrap();
        assert!(registry.remove_panel("main", &main, "connections").is_err());
        assert!(registry.add_panel("main", &main, "connections").is_err());
        let unrelated = registry.add_panel("main", &main, "output").unwrap();
        registry
            .remove_panel("main", &main, &unrelated.panel_id)
            .unwrap();
        registry.finish_native_action("connections", "wrong-id");
        assert!(registry.remove_panel("main", &main, "connections").is_err());
        registry.finish_native_action("connections", &id);
        registry.remove_panel("main", &main, "connections").unwrap();
        registry.add_panel("main", &main, "connections").unwrap();
    }
    #[test]
    fn native_actions_freeze_transfers_across_reload_until_cleanup_finishes() {
        let mut registry = Ownership::default();
        let main = registry.register("main").unwrap();
        let target = registry.register("target").unwrap();
        registry.ready("main", &main).unwrap();
        registry.ready("target", &target).unwrap();
        let lease = registry.add_panel("main", &main, "connections").unwrap();
        let id = registry.begin_native_action("main", &main, &lease).unwrap();
        assert!(registry.begin_native_action("main", &main, &lease).is_err());
        assert!(registry
            .prepare("main", &main, &lease, "target", Value::Null, Instant::now())
            .is_err());
        let main = registry.register("main").unwrap();
        registry.ready("main", &main).unwrap();
        let lease = registry.leases().remove(0);
        assert!(registry
            .prepare("main", &main, &lease, "target", Value::Null, Instant::now())
            .is_err());
        registry.finish_native_action("connections", "wrong-id");
        assert!(registry.begin_native_action("main", &main, &lease).is_err());
        registry.finish_native_action("connections", &id);
        registry
            .prepare("main", &main, &lease, "target", Value::Null, Instant::now())
            .unwrap();
        assert!(registry.begin_native_action("main", &main, &lease).is_err());
    }
}

#[cfg(test)]
mod producer_tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn a_restarted_producer_fences_late_writes_and_resets_its_revision_without_reloading_the_document(
    ) {
        let mut registry = Ownership::default();
        let main = registry.register("main").unwrap();
        let lease = registry.add_panel("main", &main, "connections").unwrap();
        let first = registry.begin_model("main", &main, "connections").unwrap();
        registry
            .publish_model("main", &main, "connections", &first, 99, json!("first"))
            .unwrap();
        let next = registry.begin_model("main", &main, "connections").unwrap();
        registry
            .publish_model("main", &main, "connections", &next, 1, json!("next"))
            .unwrap();
        assert!(registry
            .publish_model("main", &main, "connections", &first, 100, json!("late"))
            .is_err());
        assert_eq!(
            registry.read_model("main", &main, &lease).unwrap(),
            json!("next")
        );
    }
}

#[cfg(test)]
mod preview_model_tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn escaped_preview_text_has_a_separate_bounded_model_budget_not_a_larger_draft_capsule() {
        let mut registry = Ownership::default();
        let main = registry.register("main").unwrap();
        let lease = registry.add_panel("main", &main, "filePreview").unwrap();
        let publisher = registry.begin_model("main", &main, "filePreview").unwrap();
        let model = json!({ "content": "\u{0001}".repeat(2 * 1024 * 1024) });
        registry
            .publish_model("main", &main, "filePreview", &publisher, 1, model.clone())
            .unwrap();
        assert_eq!(registry.read_model("main", &main, &lease).unwrap(), model);
        assert!(registry
            .publish_model(
                "main",
                &main,
                "filePreview",
                &publisher,
                2,
                json!("x".repeat(16 * 1024 * 1024))
            )
            .is_err());
        let other = registry.add_panel("main", &main, "connections").unwrap();
        let other_publisher = registry.begin_model("main", &main, "connections").unwrap();
        assert!(registry
            .publish_model(
                "main",
                &main,
                "connections",
                &other_publisher,
                1,
                model.clone()
            )
            .is_err());
        assert!(registry
            .checkpoint("main", &main, &lease, 1, model.clone())
            .is_err());
        assert_eq!(registry.read_model("main", &main, &lease).unwrap(), model);
        assert!(registry
            .read_model("main", &main, &other)
            .unwrap()
            .is_null());
    }
}
