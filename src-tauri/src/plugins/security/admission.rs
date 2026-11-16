//! Wait for database admission without retaining global authorization. Actual
//! statements still run under policy -> database; SQLite itself is not preempted.
use super::{AppResult, Database, Lease, PluginSecurity, Policy};
use crate::services::operations::{Budget, Cancellation, Errors};
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

    pub(in crate::plugins) fn with_authorized_database<T>(
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
        self.database_then(
            db,
            |policy| {
                cancelled()?;
                Self::authorize_lease(policy, lease, permissions)
            },
            |_, conn| operation(conn?),
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
        mut attempt: impl FnMut() -> AppResult<Option<T>>,
    ) -> AppResult<T> {
        loop {
            cancelled()?;
            let result = self.with_authorized(lease, permissions, || {
                cancelled()?;
                attempt()
            })?;
            if let Some(result) = result {
                return Ok(result);
            }
            std::thread::sleep(Duration::from_millis(4));
        }
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
