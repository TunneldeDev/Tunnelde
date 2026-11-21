//! Main-admitted host-detail pages. Neither host IDs nor prefixes are authority.
use super::ownership::{Lease, Ownership, MAIN};
use serde_json::{json, Value};
use std::collections::HashMap;
struct Binding {
    document: String,
    host: String,
    allow_move: bool,
}
#[derive(Default)]
pub(super) struct Resources {
    pages: HashMap<String, Binding>,
}
impl Ownership {
    pub(super) fn bind_host_page(
        &mut self,
        window: &str,
        document: &str,
        id: &str,
        host: &str,
        allow_move: bool,
    ) -> Result<Lease, &'static str> {
        self.main(window, document)?;
        if !id
            .strip_prefix("host-view:")
            .is_some_and(|s| uuid::Uuid::parse_str(s).is_ok())
            || host.is_empty()
            || host.len() > 1024
            || host.chars().any(char::is_control)
        {
            return Err("invalid host page");
        }
        if self.panels.contains_key(id) && !self.host_pages.pages.contains_key(id) {
            return Err("unbound host page");
        }
        if self
            .host_pages
            .pages
            .get(id)
            .is_some_and(|b| b.host != host)
        {
            return Err("host page changed");
        }
        if self
            .panels
            .get(id)
            .is_some_and(|p| !p.native_actions.is_empty())
        {
            return Err("panel interaction in progress");
        }
        let lease = match self.panels.get(id) {
            Some(panel) => panel.lease.clone(),
            None => self.add_panel(window, document, id)?,
        };
        self.host_pages.pages.insert(
            id.into(),
            Binding {
                document: document.into(),
                host: host.into(),
                allow_move,
            },
        );
        Ok(lease)
    }
    pub(super) fn host_page_host(&self, id: &str) -> Option<&str> {
        self.host_pages
            .pages
            .get(id)
            .filter(|b| self.document(MAIN) == Some(b.document.as_str()))
            .map(|b| b.host.as_str())
    }
    pub(super) fn host_page_registered(&self, id: &str) -> bool {
        self.host_page_host(id).is_some()
    }
    pub(super) fn retire_host_page(&mut self, id: &str) {
        self.host_pages.pages.remove(id);
    }
    pub(super) fn host_page_move_allowed(
        &self,
        id: &str,
        target: &str,
    ) -> Result<(), &'static str> {
        if target != MAIN && self.host_pages.pages.get(id).is_some_and(|b| !b.allow_move) {
            Err("plugin.frontend.viewUnavailable")
        } else {
            Ok(())
        }
    }
    pub(super) fn host_page_descriptors(&self) -> Vec<Value> {
        self.host_pages
            .pages
            .iter()
            .filter(|(id, _)| self.host_page_registered(id))
            .map(|(id, b)| json!({"panelId":id,"allowMove":b.allow_move}))
            .collect()
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn host_actions_cannot_escape_the_bound_host_or_command_grammar() {
        let mut owner = Ownership::default();
        let main = owner.register(MAIN).unwrap();
        owner.ready(MAIN, &main).unwrap();
        let id = format!("host-view:{}", uuid::Uuid::new_v4());
        let lease = owner
            .bind_host_page(MAIN, &main, &id, "host", true)
            .unwrap();
        let command = |host: &str, operation: &str| {
            serde_json::from_value::<super::super::actions::ViewAction>(json!({
            "kind":"hostDetail","command":{"operation":operation,"host":{"id":host,"revision":uuid::Uuid::new_v4().to_string()}}
        })).unwrap()
        };
        assert!(owner
            .request_action(
                MAIN,
                &main,
                &lease,
                command("other", "favorite"),
                std::time::Instant::now()
            )
            .is_err());
        assert!(owner
            .request_action(
                MAIN,
                &main,
                &lease,
                command("host", "installKey"),
                std::time::Instant::now()
            )
            .is_err());
        assert!(owner
            .request_action(
                MAIN,
                &main,
                &lease,
                command("host", "duplicate"),
                std::time::Instant::now()
            )
            .is_ok());
    }
    #[test]
    fn admission_identity_and_movement_are_independent() {
        let mut owner = Ownership::default();
        let main = owner.register(MAIN).unwrap();
        let child = owner.register("child").unwrap();
        let id = format!("host-view:{}", uuid::Uuid::new_v4());
        assert!(!owner.transferable(&id));
        assert!(owner
            .bind_host_page("child", &child, &id, "host", true)
            .is_err());
        assert!(owner
            .bind_host_page(MAIN, &main, "host:/path", "host", true)
            .is_err());
        owner
            .bind_host_page(MAIN, &main, &id, "host", false)
            .unwrap();
        assert!(owner.transferable(&id));
        assert_eq!(owner.host_page_host(&id), Some("host"));
        assert!(owner.host_page_move_allowed(&id, "child").is_err());
        assert!(owner.host_page_move_allowed(&id, MAIN).is_ok());
        assert!(owner
            .bind_host_page(MAIN, &main, &id, "different", true)
            .is_err());
        owner
            .bind_host_page(MAIN, &main, &id, "host", true)
            .unwrap();
        assert!(owner.host_page_move_allowed(&id, "child").is_ok());
        owner.register(MAIN).unwrap();
        assert!(!owner.host_page_registered(&id));
    }
}
