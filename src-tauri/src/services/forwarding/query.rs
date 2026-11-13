//! Bounded keyset reads, coordinated with runtime admission. No public wire DTO.
use super::{
    contract::{ForwardInfo, RevisionedInfo, RevisionedRule},
    repository,
};
use crate::{
    db::Database,
    error::{AppError, AppResult},
    ssh::forward::ForwardRegistry,
};

pub(crate) fn page(
    db: &Database,
    registry: &ForwardRegistry,
    after: &str,
    limit: usize,
    check: impl Fn() -> AppResult<()>,
) -> AppResult<Vec<RevisionedInfo>> {
    if !(1..=129).contains(&limit) {
        return Err(AppError::validation("forward.invalid"));
    }
    check()?;
    registry.inspect(|runtime| {
        check()?;
        Ok(repository::page(db, after, limit, &check)?
            .into_iter()
            .map(|entry| {
                let active = runtime(&entry.rule.id);
                join(entry, active)
            })
            .collect())
    })
}

pub(super) fn join(entry: RevisionedRule, active: Option<(String, String)>) -> RevisionedInfo {
    RevisionedInfo {
        runtime_id: active.as_ref().map(|(_, identity)| identity.clone()),
        revision: entry.revision,
        info: ForwardInfo {
            active: active.is_some(),
            session_id: active.map(|(session, _)| session),
            rule: entry.rule,
        },
    }
}
