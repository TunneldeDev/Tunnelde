//! Force consent is bound to one instance; admitted stop intent belongs to the
//! host even when the caller goes away before dismount/process cleanup settles.
use super::*;
use crate::mounts::unmount::Policy;
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Target {
    pub(crate) rule: String,
    pub(crate) group: String,
    revision: String,
    pub(crate) runtime: String,
    session: Option<String>,
}
impl Target {
    pub(crate) fn capture(states: &[RuleStatus], id: &str, instance: &str) -> AppResult<Self> {
        let status = states
            .iter()
            .find(|status| status.rule_id == id && status.runtime_id.as_deref() == Some(instance))
            .ok_or_else(repository::changed)?;
        Ok(Self {
            rule: status.rule_id.clone(),
            group: status.group_id.clone(),
            revision: status.revision.clone(),
            runtime: instance.into(),
            session: status.session_id.clone(),
        })
    }
    fn matches(&self, status: &RuleStatus) -> bool {
        status.rule_id == self.rule
            && status.group_id == self.group
            && status.revision == self.revision
            && status.runtime_id.as_deref() == Some(&self.runtime)
            && status.session_id == self.session
    }
    pub(crate) fn recheck(&self, states: &[RuleStatus]) -> AppResult<()> {
        if !states.iter().any(|status| self.matches(status)) {
            return Err(repository::changed());
        }
        Ok(())
    }
}
struct Intent {
    target: Target,
    admitted: AtomicBool,
}
impl Intent {
    fn new(target: Target) -> Self {
        Self {
            target,
            admitted: AtomicBool::new(false),
        }
    }
    fn commit(
        &self,
        runtime: &Coordinator,
        commit: impl FnOnce() -> AppResult<()>,
    ) -> AppResult<()> {
        let mut book = runtime.lock();
        let status = book
            .rules
            .get_mut(&self.target.rule)
            .filter(|status| self.target.matches(status))
            .ok_or_else(repository::changed)?;
        // No await, I/O or policy reentry inside this lock. Failed admission
        // leaves the original intent, phase and runtime completely unchanged.
        commit()?;
        status.desired = false;
        self.admitted.store(true, Ordering::Release);
        Ok(())
    }
    fn settle(&self, runtime: &Coordinator, result: &AppResult<()>) -> bool {
        if !self.admitted.load(Ordering::Acquire) {
            return false;
        }
        let mut book = runtime.lock();
        let Some(status) = book
            .rules
            .get_mut(&self.target.rule)
            .filter(|status| self.target.matches(status))
        else {
            return false;
        };
        status.desired = false;
        match result {
            Ok(()) => {
                status.phase = "stopped".into();
                status.runtime_id = None;
                status.session_id = None;
                status.error = None;
            }
            Err(error) => {
                status.phase = "cleanupRequired".into();
                status.error = Some(super::super::operations::error_value(error));
            }
        }
        true
    }
}
struct ForcePolicy {
    app: AppHandle,
    authority: Authority,
    intent: Intent,
    // Held until the actual worker finishes AND host state is settled, not
    // merely until the caller stops waiting. Recovery/edits cannot overtake it.
    _group: OwnedMutexGuard<()>,
}
impl Policy for ForcePolicy {
    fn with_authorized<T>(&self, effect: impl FnOnce() -> AppResult<T>) -> AppResult<T> {
        self.authority.commit(&self.app, effect)
    }
    fn commit(&self, effect: impl FnOnce() -> AppResult<()>) -> AppResult<()> {
        self.intent
            .commit(&self.app.state::<AppState>().mount_runtime, effect)
    }
    fn admitted(&self) {
        changed(&self.app);
    }
    fn settled(&self, result: &AppResult<()>) {
        // This is completion of an ALREADY admitted effect, not a new plugin
        // write. Reauthorizing here would resurrect force-stopped rules after
        // request expiry, document retirement or permission revocation.
        if self
            .intent
            .settle(&self.app.state::<AppState>().mount_runtime, result)
        {
            changed(&self.app);
        }
    }
}
pub(crate) fn policy(
    app: &AppHandle,
    authority: Authority,
    target: Target,
    group: OwnedMutexGuard<()>,
) -> impl Policy {
    ForcePolicy {
        app: app.clone(),
        authority,
        intent: Intent::new(target),
        _group: group,
    }
}

#[cfg(test)]
pub(crate) mod tests;
