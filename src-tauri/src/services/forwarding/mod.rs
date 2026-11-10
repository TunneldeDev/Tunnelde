//! Shared TCP-forwarding contracts, persistence and committed invalidations.
//! Callers authorize; SSH transport remains internal to the runtime adapter.
use crate::{db::Database, error::AppResult, ssh::forward::ForwardRegistry, state::AppState};
use tauri::{AppHandle, Emitter, Manager};
pub mod contract;
mod repository;
use contract::{validate, ForwardInfo, ForwardRule};

pub(crate) fn registry(app: &AppHandle) -> ForwardRegistry {
    let app = app.clone();
    ForwardRegistry::with_notifier(move || {
        let _ = app.emit(
            "plugin://domain-changed",
            serde_json::json!({"domain":"forwards"}),
        );
    })
}

struct Forwarding<'a> {
    db: &'a Database,
    registry: &'a ForwardRegistry,
}
impl Forwarding<'_> {
    fn rules(&self) -> AppResult<Vec<ForwardRule>> {
        repository::list(self.db)
    }
    fn list(&self) -> AppResult<Vec<ForwardInfo>> {
        let rules = self.rules()?;
        let active = self.registry.snapshot()?;
        Ok(rules
            .into_iter()
            .map(|rule| {
                let session_id = active.get(&rule.id).cloned();
                ForwardInfo {
                    active: session_id.is_some(),
                    session_id,
                    rule,
                }
            })
            .collect())
    }
    fn save(&self, mut rule: ForwardRule) -> AppResult<ForwardRule> {
        if rule.id.is_empty() {
            rule.id = uuid::Uuid::new_v4().to_string();
        }
        validate(&rule)?;
        self.registry
            .edit(&rule.id, || repository::save(self.db, &rule))
    }
    fn remove(&self, id: &str) -> AppResult<()> {
        self.registry
            .remove_rule(id, || repository::remove(self.db, id))
    }
}

fn service(state: &AppState) -> Forwarding<'_> {
    Forwarding {
        db: &state.db,
        registry: &state.forwards,
    }
}
pub(crate) fn rules(app: &AppHandle) -> AppResult<Vec<ForwardRule>> {
    service(&app.state::<AppState>()).rules()
}
pub fn list(app: &AppHandle) -> AppResult<Vec<ForwardInfo>> {
    service(&app.state::<AppState>()).list()
}
pub fn save(app: &AppHandle, rule: ForwardRule) -> AppResult<ForwardRule> {
    service(&app.state::<AppState>()).save(rule)
}
pub fn remove(app: &AppHandle, id: &str) -> AppResult<()> {
    service(&app.state::<AppState>()).remove(id)
}
pub async fn start_owned(
    app: &AppHandle,
    id: &str,
    session_id: &str,
    owner: Option<(String, u64)>,
) -> AppResult<()> {
    crate::ssh::forward::start_owned(app, id, session_id, owner).await
}
pub async fn stop(app: &AppHandle, id: &str) -> AppResult<()> {
    app.state::<AppState>().forwards.stop(id).await
}

#[cfg(test)]
mod tests;
