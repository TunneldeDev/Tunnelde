//! Private correlation is not a global SSH-test ID or transferable authority.
//! Active records last through actual Effect cleanup; live-dialog tombstones
//! are bounded and never evicted to let a canceled/replayed request run later.
use super::*;
use std::{collections::HashMap, future::Future};
use tokio::sync::watch;

const LIMIT: usize = 64;
#[derive(Clone, PartialEq, Eq)]
pub(super) struct Scope {
    window: String,
    document: String,
    lease: Lease,
    interaction: String,
    provider: Option<String>,
}
impl Scope {
    pub(super) fn new(window: &str, document: &str, lease: &Lease, interaction: &str) -> Self {
        Self {
            window: window.into(),
            document: document.into(),
            lease: lease.clone(),
            interaction: interaction.into(),
            provider: None,
        }
    }
    pub(super) fn provider(mut self, provider: Option<&str>) -> Self {
        self.provider = provider.map(str::to_owned);
        self
    }
    fn current(&self, owner: &Ownership) -> Result<(), &'static str> {
        owner.forwarding_scope_current(
            &self.window,
            &self.document,
            &self.lease,
            Some(&self.interaction),
        )?;
        if let Some(token) = &self.provider {
            owner.forwarding_provider_binding(
                (&self.window, &self.document),
                &self.lease,
                token,
            )?;
        }
        Ok(())
    }
}
struct Record {
    scope: Scope,
    action: Option<String>,
    completed: bool,
    cancel: watch::Sender<bool>,
}
#[derive(Default)]
pub(crate) struct Registry {
    records: HashMap<String, Record>,
}
impl Registry {
    pub(super) fn check_action(&self, action: &str) -> Result<(), &'static str> {
        if self
            .records
            .values()
            .any(|record| record.action.as_deref() == Some(action) && *record.cancel.borrow())
        {
            return Err("ssh.testCancelled");
        }
        Ok(())
    }
    fn receiver(&self, id: &str, action: &str) -> Result<watch::Receiver<bool>, &'static str> {
        let record = self
            .records
            .get(id)
            .filter(|r| r.action.as_deref() == Some(action))
            .ok_or("ssh.testCancelled")?;
        Ok(record.cancel.subscribe())
    }
    fn complete(&mut self, id: &str, action: &str) -> Result<(), &'static str> {
        let record = self
            .records
            .get_mut(id)
            .filter(|r| r.action.as_deref() == Some(action))
            .ok_or("ssh.testCancelled")?;
        if *record.cancel.borrow() || record.completed {
            return Err("ssh.testCancelled");
        }
        record.completed = true;
        Ok(())
    }
}
impl Ownership {
    fn prune_forwarding_tests(&mut self) {
        let retired: Vec<_> = self
            .forwarding_tests
            .records
            .iter()
            .filter(|(_, record)| record.scope.current(self).is_err())
            .map(|(id, _)| id.clone())
            .collect();
        for id in retired {
            if let Some(record) = self.forwarding_tests.records.get_mut(&id) {
                if record.action.is_some() {
                    if !record.completed {
                        record.cancel.send_replace(true);
                    }
                } else {
                    self.forwarding_tests.records.remove(&id);
                }
            }
        }
    }
    pub(super) fn begin_forwarding_test(
        &mut self,
        id: &str,
        scope: Scope,
        action: &str,
    ) -> Result<(), &'static str> {
        scope.current(self)?;
        self.prune_forwarding_tests();
        if let Some(record) = self.forwarding_tests.records.get(id) {
            return Err(if record.scope == scope {
                "ssh.testCancelled"
            } else {
                "invalid test owner"
            });
        }
        if self.forwarding_tests.records.len() >= LIMIT {
            return Err("ssh.sessionBusy");
        }
        let (cancel, _) = watch::channel(false);
        self.forwarding_tests.records.insert(
            id.into(),
            Record {
                scope,
                action: Some(action.into()),
                completed: false,
                cancel,
            },
        );
        Ok(())
    }
    pub(super) fn cancel_forwarding_test(
        &mut self,
        id: &str,
        scope: Scope,
    ) -> Result<(), &'static str> {
        // Cleanup of an already admitted exact request needs no new consent.
        // It can never retarget another document/lease/interaction/test.
        if let Some(record) = self.forwarding_tests.records.get_mut(id) {
            if record.scope != scope {
                return Err("invalid test owner");
            }
            if !record.completed {
                record.cancel.send_replace(true);
            }
            return Ok(());
        }
        scope.current(self)?;
        self.prune_forwarding_tests();
        if self.forwarding_tests.records.len() >= LIMIT {
            return Err("ssh.sessionBusy");
        }
        let (cancel, _) = watch::channel(true);
        self.forwarding_tests.records.insert(
            id.into(),
            Record {
                scope,
                action: None,
                completed: false,
                cancel,
            },
        );
        Ok(())
    }
    pub(super) fn finish_forwarding_action(&mut self, panel: &str, action: &str) {
        for record in self
            .forwarding_tests
            .records
            .values_mut()
            .filter(|r| r.action.as_deref() == Some(action))
        {
            record.action = None;
            record.completed = true;
        }
        self.finish_native_action(panel, action);
        self.prune_forwarding_tests();
    }
}
pub(crate) fn prune(app: &AppHandle) {
    let registry = app.state::<native::Registry>();
    let mut ownership = native::lock(&registry);
    ownership.prune_forwarding_tests();
    // A readable provider may lose write access without its view closing. An
    // in-flight diagnostic still needs cancellation, not just denied delivery.
    for record in ownership.forwarding_tests.records.values() {
        if record.completed {
            continue;
        }
        if let Some(token) = &record.scope.provider {
            let scope = &record.scope;
            let current = ownership
                .forwarding_provider_authority(
                    (&scope.window, &scope.document),
                    &scope.lease,
                    token,
                )
                .map_err(native::invalid)
                .and_then(|authority| authority.with_current(app, true, || Ok(())));
            if current.is_err() {
                record.cancel.send_replace(true);
            }
        }
    }
}
async fn guard<T>(
    mut cancel: watch::Receiver<bool>,
    work: impl Future<Output = AppResult<T>>,
) -> AppResult<T> {
    let cancelled = async move {
        if *cancel.borrow() {
            return;
        }
        while cancel.changed().await.is_ok() {
            if *cancel.borrow() {
                return;
            }
        }
    };
    tokio::select! { biased;
        _ = cancelled => Err(AppError::validation("ssh.testCancelled")),
        result = work => result,
    }
}
pub(super) async fn run(
    effect: Arc<Effect>,
    id: String,
    revision: String,
    review: crate::ssh::session::review::Review,
    test_id: String,
    credentials: connection::JumpCredentials,
) -> AppResult<Value> {
    let cancellation = native::lock(&effect.app.state::<native::Registry>())
        .forwarding_tests
        .receiver(&test_id, &effect.id)
        .map_err(native::invalid)?;
    guard(cancellation, async {
        let target = connection::reviewed_target(&effect, &id, &revision, &review).await?;
        let credentials = credentials.for_target(&target)?;
        let quality =
            crate::ssh::diagnostics::test_captured(&effect.app, &target, &credentials).await?;
        let observed = target.observe_background(&effect.app).await?;
        crate::services::credentials::checked(move |job| {
            effect.with_ownership(|owner| {
                observed.with_current(&effect.app, |conn| {
                    domain::repository::require_reviewed_host(
                        conn,
                        &id,
                        &revision,
                        &review.host_id,
                    )?;
                    job.commit()?;
                    owner
                        .forwarding_tests
                        .complete(&test_id, &effect.id)
                        .map_err(native::invalid)?;
                    Ok(json!(quality))
                })
            })
        })
        .await
    })
    .await
}
#[cfg(test)]
mod tests;
