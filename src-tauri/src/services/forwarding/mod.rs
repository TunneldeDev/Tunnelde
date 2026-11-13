//! Shared TCP-forwarding contracts, persistence and committed invalidations.
//! Callers authorize; SSH transport remains internal to the runtime adapter.
use crate::{db::Database, error::AppResult, ssh::forward::ForwardRegistry, state::AppState};
use tauri::{AppHandle, Emitter, Manager};
pub mod contract;
pub(crate) mod query;
mod repository;
mod runtime;
use contract::{validate, ForwardInfo, ForwardRule, RevisionedInfo, RevisionedRule};
pub(crate) use runtime::{prepare_checked, take_checked};
pub use runtime::{start_checked, stop};

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
    fn rules(&self) -> AppResult<Vec<RevisionedRule>> {
        repository::list(self.db)
    }
    fn list(&self) -> AppResult<Vec<ForwardInfo>> {
        Ok(self
            .list_revisioned()?
            .into_iter()
            .map(|entry| entry.info)
            .collect())
    }
    fn list_revisioned(&self) -> AppResult<Vec<RevisionedInfo>> {
        self.registry.inspect(|runtime| {
            Ok(self
                .rules()?
                .into_iter()
                .map(|entry| {
                    let active = runtime(&entry.rule.id);
                    query::join(entry, active)
                })
                .collect())
        })
    }
    fn save(&self, rule: ForwardRule) -> AppResult<ForwardRule> {
        Ok(self.save_checked(rule, None)?.rule)
    }
    fn save_checked(
        &self,
        mut rule: ForwardRule,
        expected: Option<&str>,
    ) -> AppResult<RevisionedRule> {
        if rule.id.is_empty() {
            if expected.is_some() {
                return Err(crate::error::AppError::validation("forward.changed"));
            }
            rule.id = uuid::Uuid::new_v4().to_string();
        }
        validate(&rule)?;
        self.registry
            .edit(&rule.id, || repository::save(self.db, &rule, expected))
    }
    fn remove(&self, id: &str) -> AppResult<()> {
        self.remove_checked(id, None)
    }
    fn remove_checked(&self, id: &str, expected: Option<&str>) -> AppResult<()> {
        self.registry
            .remove_rule(id, || repository::remove(self.db, id, expected))
    }
}

fn service(state: &AppState) -> Forwarding<'_> {
    Forwarding {
        db: &state.db,
        registry: &state.forwards,
    }
}
pub fn list(app: &AppHandle) -> AppResult<Vec<ForwardInfo>> {
    service(&app.state::<AppState>()).list()
}
pub fn list_revisioned(app: &AppHandle) -> AppResult<Vec<RevisionedInfo>> {
    service(&app.state::<AppState>()).list_revisioned()
}
pub fn save(app: &AppHandle, rule: ForwardRule) -> AppResult<ForwardRule> {
    service(&app.state::<AppState>()).save(rule)
}
pub fn save_checked(
    app: &AppHandle,
    rule: ForwardRule,
    expected: Option<&str>,
) -> AppResult<RevisionedRule> {
    service(&app.state::<AppState>()).save_checked(rule, expected)
}
pub fn remove(app: &AppHandle, id: &str) -> AppResult<()> {
    service(&app.state::<AppState>()).remove(id)
}
pub fn remove_checked(app: &AppHandle, id: &str, expected: Option<&str>) -> AppResult<()> {
    service(&app.state::<AppState>()).remove_checked(id, expected)
}
#[cfg(test)]
mod tests;
