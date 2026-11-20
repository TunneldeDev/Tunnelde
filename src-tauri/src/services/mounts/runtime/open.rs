//! Final launch admission checks the exact rule instance under its group gate;
//! opening a folder must not mutate stop intent or own/disconnect user SSH.
use super::*;
use crate::mounts::unmount::Policy;
struct OpenPolicy {
    app: AppHandle,
    authority: Authority,
    target: force::Target,
    _group: OwnedMutexGuard<()>,
}
impl Policy for OpenPolicy {
    fn with_authorized<T>(&self, effect: impl FnOnce() -> AppResult<T>) -> AppResult<T> {
        self.authority.commit(&self.app, effect)
    }
    fn commit(&self, effect: impl FnOnce() -> AppResult<()>) -> AppResult<()> {
        self.target
            .recheck(&self.app.state::<AppState>().mount_runtime.rule_states())?;
        effect()
    }
}
pub(crate) fn policy(
    app: &AppHandle,
    authority: Authority,
    target: force::Target,
    group: OwnedMutexGuard<()>,
) -> impl Policy {
    OpenPolicy {
        app: app.clone(),
        authority,
        target,
        _group: group,
    }
}
