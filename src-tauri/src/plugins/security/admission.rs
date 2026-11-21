//! Wait for database admission without retaining global authorization. Actual
//! statements still run under policy -> database; SQLite itself is not preempted.
use super::{AppResult, Database, Lease, PluginSecurity, Policy};
use crate::services::operations::{Authority, Budget, Cancellation, Errors};
use rusqlite::Connection;
use std::{sync::LazyLock, time::Duration};

pub(in crate::plugins) async fn blocking<T: Send + 'static>(
    operation: impl FnOnce(&Cancellation) -> AppResult<T> + Send + 'static,
) -> AppResult<T> {
    static WORKERS: LazyLock<Budget> = LazyLock::new(|| {
        Budget::new(
            4,
            Errors {
                domain: "pluginSecurity.operation",
                busy: "pluginSecurity.operation.busy",
                cancelled: "pluginSecurity.operation.cancelled",
                failed: "pluginSecurity.operation.unavailable",
            },
        )
    });
    WORKERS.blocking(operation).await
}

impl PluginSecurity {
    /// An admission error is passed through so restriction/revocation can remain
    /// fail closed even if the database mutex is poisoned. Callback runs once.
    /// Checks contain cancellation/policy validation only, never external IO.
    pub(super) fn database<T>(
        &self,
        db: &Database,
        check: impl Fn(&Policy) -> AppResult<()>,
        operation: impl FnOnce(&mut Policy, AppResult<&Connection>) -> AppResult<T>,
    ) -> AppResult<T> {
        self.database_then(db, check, operation, Ok)
    }

    fn database_then<T, U>(
        &self,
        db: &Database,
        check: impl Fn(&Policy) -> AppResult<()>,
        operation: impl FnOnce(&mut Policy, AppResult<&Connection>) -> AppResult<T>,
        publish: impl FnOnce(T) -> AppResult<U>,
    ) -> AppResult<U> {
        let mut operation = Some(operation);
        loop {
            let mut policy = self.policy();
            check(&policy)?;
            let result = db.try_with(|conn| {
                // Nest operation errors to distinguish them from admission.
                Ok(check(&policy).and_then(|()| {
                    operation.take().expect("database operation admitted once")(
                        &mut policy,
                        Ok(conn),
                    )
                }))
            });
            match result {
                Ok(Some(result)) => return publish(result?),
                Err(error) => {
                    return publish(operation.take().expect("database admission failed")(
                        &mut policy,
                        Err(error),
                    )?);
                }
                Ok(None) => {}
            }
            drop(policy);
            // Retained workers or synchronous startup/shutdown only. No policy,
            // metadata or DB guard spans this wait.
            std::thread::sleep(Duration::from_millis(4));
        }
    }

    pub(crate) fn with_authorized_database<T>(
        &self,
        db: &Database,
        lease: &Lease,
        permissions: &[&str],
        cancelled: impl Fn() -> AppResult<()>,
        operation: impl FnOnce(&Connection) -> AppResult<T>,
    ) -> AppResult<T> {
        self.database(
            db,
            |policy| {
                cancelled()?;
                Self::authorize_lease(policy, lease, permissions)
            },
            |_, conn| operation(conn?),
        )
    }

    /// Publication follows DB release under the same policy lock. A settings
    /// writer retains serialization, so revocation cannot split durable commit
    /// from in-memory publication and no new DB -> settings/update lock is added.
    pub(in crate::plugins) fn with_authorized_database_then<T, U>(
        &self,
        db: &Database,
        lease: &Lease,
        permissions: &[&str],
        cancelled: impl Fn() -> AppResult<()>,
        operation: impl FnOnce(&Connection) -> AppResult<T>,
        publish: impl FnOnce(T) -> AppResult<U>,
    ) -> AppResult<U> {
        self.with_authorized_fenced_database_then(
            db,
            lease,
            permissions,
            cancelled,
            None,
            operation,
            publish,
        )
    }

    /// Preserve policy -> metadata -> DB without retaining preceding guards
    /// while DB is occupied. Each attempt must use try_with and consume input
    /// only when admitted; never retry an already executed or unknown write.
    pub(in crate::plugins) fn with_authorized_attempt<T>(
        &self,
        lease: &Lease,
        permissions: &[&str],
        cancelled: impl Fn() -> AppResult<()>,
        attempt: impl FnMut() -> AppResult<Option<T>>,
    ) -> AppResult<T> {
        self.with_authorized_fenced_attempt(lease, permissions, cancelled, None, attempt)
    }

    /// The original document's authority precedes policy/metadata/DB. Each
    /// callback must try admission, never wait for another owner while fenced.
    /// Release ALL guards before retrying; a retired origin can then interrupt
    /// a DB wait without ever admitting SQL on behalf of its replacement.
    pub(in crate::plugins) fn with_authorized_fenced_attempt<T>(
        &self,
        lease: &Lease,
        permissions: &[&str],
        cancelled: impl Fn() -> AppResult<()>,
        authority: Option<&dyn Authority>,
        mut attempt: impl FnMut() -> AppResult<Option<T>>,
    ) -> AppResult<T> {
        loop {
            cancelled()?;
            let mut result = None;
            let mut admit = || {
                result = Some(self.with_authorized(lease, permissions, || {
                    cancelled()?;
                    attempt()
                })?);
                Ok(())
            };
            match authority {
                Some(authority) => authority.with_current(&mut admit)?,
                None => admit()?,
            }
            if let Some(result) = result.expect("authority must admit before succeeding") {
                return Ok(result);
            }
            std::thread::sleep(Duration::from_millis(4));
        }
    }

    /// Short final database transaction under exact origin -> policy -> DB.
    /// Unlike fencing the older blocking database loop, this never retains a
    /// native ownership mutex while waiting for another database consumer.
    pub(in crate::plugins) fn with_authorized_fenced_database<T>(
        &self,
        db: &Database,
        lease: &Lease,
        permissions: &[&str],
        cancelled: impl Fn() -> AppResult<()>,
        authority: Option<&dyn Authority>,
        operation: impl FnOnce(&Connection) -> AppResult<T>,
    ) -> AppResult<T> {
        self.with_authorized_fenced_database_then(
            db,
            lease,
            permissions,
            cancelled,
            authority,
            operation,
            Ok,
        )
    }

    /// Publish after releasing DB but before releasing original origin/policy.
    /// Each unsuccessful DB attempt releases every preceding guard. A settings
    /// writer retains its independent serialization through commit/publication.
    #[allow(
        clippy::too_many_arguments,
        reason = "explicit commit and publication phases share one authority boundary"
    )]
    pub(in crate::plugins) fn with_authorized_fenced_database_then<T, U>(
        &self,
        db: &Database,
        lease: &Lease,
        permissions: &[&str],
        cancelled: impl Fn() -> AppResult<()>,
        authority: Option<&dyn Authority>,
        operation: impl FnOnce(&Connection) -> AppResult<T>,
        publish: impl FnOnce(T) -> AppResult<U>,
    ) -> AppResult<U> {
        let mut operation = Some(operation);
        let mut publish = Some(publish);
        self.with_authorized_fenced_attempt(lease, permissions, cancelled, authority, || {
            match db.try_with(|conn| {
                operation.take().expect("database operation admitted once")(conn)
            })? {
                Some(result) => Ok(Some(publish.take().expect("publication admitted once")(
                    result,
                )?)),
                None => Ok(None),
            }
        })
    }

    pub(super) fn authorize_lease(
        policy: &Policy,
        lease: &Lease,
        permissions: &[&str],
    ) -> AppResult<()> {
        Self::authorize_policy(
            policy,
            &lease.id,
            &lease.fingerprint,
            &lease.permissions,
            None,
            Some(lease.generation),
        )?;
        for permission in permissions {
            Self::authorize_policy(
                policy,
                &lease.id,
                &lease.fingerprint,
                &lease.permissions,
                Some(permission),
                Some(lease.generation),
            )?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests;
