//! Settings identity and private credential drafts. Drafts never enter public
//! descriptors, model publications, transfer capsules, layouts or action jobs.
use super::ownership::{Lease, Ownership, MAIN};
use super::plugin_views::Target;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::time::Instant;
use zeroize::Zeroizing;

struct Binding {
    document: String,
    allow_move: bool,
    password: Zeroizing<String>,
}
#[derive(Default)]
pub(super) struct Resources {
    pages: HashMap<String, Binding>,
}
impl Ownership {
    pub(super) fn bind_settings_page(
        &mut self,
        window: &str,
        document: &str,
        id: &str,
        allow_move: bool,
    ) -> Result<Lease, &'static str> {
        self.main(window, document)?;
        if !id
            .strip_prefix("settings-view:")
            .is_some_and(|s| uuid::Uuid::parse_str(s).is_ok())
        {
            return Err("invalid settings page");
        }
        if self.panels.contains_key(id) && !self.settings_pages.pages.contains_key(id) {
            return Err("unbound settings page");
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
        // Updating eligibility must not replace a live private draft.
        let binding = self
            .settings_pages
            .pages
            .entry(id.into())
            .or_insert_with(|| Binding {
                document: document.into(),
                allow_move,
                password: Zeroizing::new(String::new()),
            });
        if binding.document != document {
            *binding = Binding {
                document: document.into(),
                allow_move,
                password: Zeroizing::new(String::new()),
            };
        } else {
            binding.allow_move = allow_move;
        }
        Ok(lease)
    }
    pub(super) fn settings_page_registered(&self, id: &str) -> bool {
        self.settings_pages
            .pages
            .get(id)
            .is_some_and(|b| self.document(MAIN) == Some(b.document.as_str()))
    }
    pub(super) fn retire_settings_page(&mut self, id: &str) {
        self.settings_pages.pages.remove(id);
    }
    pub(super) fn clear_settings_drafts(&mut self) {
        // Reload retires authority, but keep registrations for safe re-admission
        // of existing panels. Dropping Zeroizing also erases retired bytes.
        for binding in self.settings_pages.pages.values_mut() {
            binding.password = Zeroizing::new(String::new());
        }
    }
    pub(super) fn settings_page_move_allowed(
        &self,
        id: &str,
        target: &str,
    ) -> Result<(), &'static str> {
        if target != MAIN
            && self
                .settings_pages
                .pages
                .get(id)
                .is_some_and(|b| !b.allow_move)
        {
            Err("plugin.frontend.viewUnavailable")
        } else {
            Ok(())
        }
    }
    pub(super) fn settings_page_descriptors(&self) -> Vec<Value> {
        self.settings_pages
            .pages
            .iter()
            .filter(|(id, _)| self.settings_page_registered(id))
            .map(|(id, b)| json!({"panelId":id,"allowMove":b.allow_move}))
            .collect()
    }
    pub(super) fn write_settings_password(
        &mut self,
        window: &str,
        document: &str,
        lease: &Lease,
        value: String,
    ) -> Result<(), &'static str> {
        // Only the exact current, unfrozen settings renderer may submit a draft.
        let value = Zeroizing::new(value);
        self.resource_action(window, document, lease)?;
        if !self.settings_page_registered(&lease.panel_id) || value.len() > 8192 {
            return Err("invalid settings draft");
        }
        self.settings_pages
            .pages
            .get_mut(&lease.panel_id)
            .unwrap()
            .password = value;
        Ok(())
    }
    pub(super) fn read_settings_password(
        &self,
        window: &str,
        document: &str,
        target: &Target,
        now: Instant,
    ) -> Result<String, &'static str> {
        let id = match target {
            Target::Owned { lease } => &self.owned(window, document, lease)?.lease.panel_id,
            Target::Staged { id } => &self.staged(window, document, id, now)?.offer.lease.panel_id,
        };
        if !self.settings_page_registered(id) {
            return Err("invalid settings draft");
        }
        Ok(self.settings_pages.pages[id].password.to_string())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn private_draft_follows_exact_transfer_but_never_public_state() {
        let mut owner = Ownership::default();
        let main = owner.register(MAIN).unwrap();
        let child = owner.register("child").unwrap();
        let stranger = owner.register("stranger").unwrap();
        owner.ready(MAIN, &main).unwrap();
        owner.ready("child", &child).unwrap();
        let id = format!("settings-view:{}", uuid::Uuid::new_v4());
        assert!(!owner.transferable(&id));
        assert!(owner
            .bind_settings_page("child", &child, &id, true)
            .is_err());
        let lease = owner.bind_settings_page(MAIN, &main, &id, true).unwrap();
        assert!(owner.transferable(&id));
        owner
            .write_settings_password(MAIN, &main, &lease, "private-draft".into())
            .unwrap();
        owner.bind_settings_page(MAIN, &main, &id, false).unwrap();
        assert!(owner.settings_page_move_allowed(&id, "child").is_err());
        owner.bind_settings_page(MAIN, &main, &id, true).unwrap();
        let now = Instant::now();
        let offer = owner
            .prepare(MAIN, &main, &lease, "child", json!({"draft":"public"}), now)
            .unwrap();
        assert!(owner
            .write_settings_password(MAIN, &main, &lease, "late".into())
            .is_err());
        let target = Target::Staged {
            id: offer.id.clone(),
        };
        assert_eq!(
            owner
                .read_settings_password("child", &child, &target, now)
                .unwrap(),
            "private-draft"
        );
        assert!(owner
            .read_settings_password("stranger", &stranger, &target, now)
            .is_err());
        assert!(!serde_json::to_string(&owner.settings_page_descriptors())
            .unwrap()
            .contains("private-draft"));
        assert!(!owner
            .staged("child", &child, &offer.id, now)
            .unwrap()
            .state
            .to_string()
            .contains("private-draft"));
        owner.acknowledge("child", &child, &offer.id, now).unwrap();
        let promoted = owner.commit(MAIN, &main, &offer.id, now).unwrap();
        assert!(owner
            .read_settings_password(MAIN, &main, &Target::Owned { lease }, now)
            .is_err());
        assert_eq!(
            owner
                .read_settings_password(
                    "child",
                    &child,
                    &Target::Owned {
                        lease: promoted.clone()
                    },
                    now
                )
                .unwrap(),
            "private-draft"
        );
        owner
            .write_settings_password("child", &child, &promoted, String::new())
            .unwrap();
        owner.remove_panel(MAIN, &main, &id).unwrap();
        assert!(owner
            .read_settings_password("child", &child, &Target::Owned { lease: promoted }, now)
            .is_err());
    }
    #[test]
    fn bounds_reload_and_non_settings_leases_cannot_expose_credentials() {
        let mut owner = Ownership::default();
        let main = owner.register(MAIN).unwrap();
        owner.ready(MAIN, &main).unwrap();
        let id = format!("settings-view:{}", uuid::Uuid::new_v4());
        let lease = owner.bind_settings_page(MAIN, &main, &id, true).unwrap();
        assert!(owner
            .write_settings_password(MAIN, &main, &lease, "x".repeat(8193))
            .is_err());
        owner
            .write_settings_password(MAIN, &main, &lease, "erase-on-reload".into())
            .unwrap();
        let other = owner.add_panel(MAIN, &main, "connections").unwrap();
        assert!(owner
            .read_settings_password(
                MAIN,
                &main,
                &Target::Owned {
                    lease: other.clone()
                },
                Instant::now()
            )
            .is_err());
        assert!(owner
            .write_settings_password(MAIN, &main, &other, "no".into())
            .is_err());
        let next = owner.register(MAIN).unwrap();
        assert!(!owner.settings_page_registered(&id));
        let lease = owner.bind_settings_page(MAIN, &next, &id, true).unwrap();
        assert_eq!(
            owner
                .read_settings_password(MAIN, &next, &Target::Owned { lease }, Instant::now())
                .unwrap(),
            ""
        );
    }
    #[test]
    fn main_secret_reader_requires_main_document_and_current_registered_owner() {
        use super::super::protocol::Command;
        let mut owner = Ownership::default();
        let main = owner.register(MAIN).unwrap();
        let child = owner.register("child").unwrap();
        owner.ready(MAIN, &main).unwrap();
        owner.ready("child", &child).unwrap();
        let id = format!("settings-view:{}", uuid::Uuid::new_v4());
        let lease = owner.bind_settings_page(MAIN, &main, &id, true).unwrap();
        owner
            .write_settings_password(MAIN, &main, &lease, "private".into())
            .unwrap();
        let now = Instant::now();
        assert!(owner
            .dispatch(
                "child",
                &child,
                Command::ReadSettingsPasswordForOwner {
                    lease: lease.clone()
                },
                now
            )
            .is_err());
        let offer = owner
            .prepare(MAIN, &main, &lease, "child", Value::Null, now)
            .unwrap();
        owner.acknowledge("child", &child, &offer.id, now).unwrap();
        let moved = owner.commit(MAIN, &main, &offer.id, now).unwrap();
        assert!(owner
            .dispatch(
                MAIN,
                &main,
                Command::ReadSettingsPasswordForOwner { lease },
                now
            )
            .is_err());
        assert_eq!(
            owner
                .dispatch(
                    MAIN,
                    &main,
                    Command::ReadSettingsPasswordForOwner {
                        lease: moved.clone()
                    },
                    now
                )
                .unwrap(),
            json!("private")
        );
        assert!(owner
            .dispatch(
                "child",
                &child,
                Command::ReadSettingsPasswordForOwner {
                    lease: moved.clone()
                },
                now
            )
            .is_err());
        owner.register("child").unwrap();
        assert!(owner
            .dispatch(
                MAIN,
                &main,
                Command::ReadSettingsPasswordForOwner { lease: moved },
                now
            )
            .is_err());
    }
}
