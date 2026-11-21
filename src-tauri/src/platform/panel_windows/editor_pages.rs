//! Main-admitted editor identities. Paths never serve as capabilities or native IDs.
use super::ownership::{Lease, Ownership, MAIN};
use serde_json::{json, Value};
use std::collections::HashMap;
#[derive(Default)]
pub(super) struct Resources {
    documents: HashMap<String, String>,
}
impl Ownership {
    pub(super) fn bind_editor_page(
        &mut self,
        window: &str,
        document: &str,
        id: &str,
    ) -> Result<Lease, &'static str> {
        self.main(window, document)?;
        if !id
            .strip_prefix("editor-view:")
            .is_some_and(|s| uuid::Uuid::parse_str(s).is_ok())
        {
            return Err("invalid editor page");
        }
        if self.panels.contains_key(id) && !self.editor_pages.documents.contains_key(id) {
            return Err("unbound editor page");
        }
        if self
            .panels
            .get(id)
            .is_some_and(|panel| !panel.native_actions.is_empty())
        {
            return Err("panel interaction in progress");
        }
        let lease = match self.panels.get(id) {
            Some(panel) => panel.lease.clone(),
            None => self.add_panel(window, document, id)?,
        };
        self.editor_pages
            .documents
            .insert(id.into(), document.into());
        Ok(lease)
    }
    pub(super) fn editor_page_registered(&self, id: &str) -> bool {
        self.editor_pages
            .documents
            .get(id)
            .is_some_and(|d| self.document(MAIN) == Some(d.as_str()))
    }
    pub(super) fn retire_editor_page(&mut self, id: &str) {
        self.editor_pages.documents.remove(id);
    }
    pub(super) fn editor_page_descriptors(&self) -> Vec<Value> {
        self.editor_pages
            .documents
            .keys()
            .filter(|id| self.editor_page_registered(id))
            .map(|id| json!({"panelId": id}))
            .collect()
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn prefixes_are_not_admission_and_reload_revokes_registration() {
        let mut owner = Ownership::default();
        let main = owner.register(MAIN).unwrap();
        let other = owner.register("other").unwrap();
        let id = format!("editor-view:{}", uuid::Uuid::new_v4());
        assert!(!owner.transferable(&id));
        assert!(owner.bind_editor_page("other", &other, &id).is_err());
        assert!(owner
            .bind_editor_page(MAIN, &main, "editor-local:/tmp/a")
            .is_err());
        let lease = owner.bind_editor_page(MAIN, &main, &id).unwrap();
        assert!(owner.transferable(&id));
        let publisher = owner.begin_model(MAIN, &main, &id).unwrap();
        owner
            .publish_model(
                MAIN,
                &main,
                &id,
                &publisher,
                1,
                json!({"content": "\u{0001}".repeat(2*1024*1024)}),
            )
            .unwrap();
        assert!(owner
            .checkpoint(MAIN, &main, &lease, 1, json!("x".repeat(1024 * 1024)))
            .is_err());
        owner.register(MAIN).unwrap();
        assert!(!owner.editor_page_registered(&id));
    }
}
