//! Policy transitions are admitted against the current policy and exact DB.
//! Restriction/revocation fail closed; grants publish only after persistence.
use super::*;

impl PluginSecurity {
    #[cfg(test)]
    pub fn set_restricted(&self, db: &Database, enabled: bool, cli: bool) -> AppResult<()> {
        self.database(
            db,
            |_| Ok(()),
            |policy, conn| Self::restrict_on(policy, conn, enabled, cli, self),
        )
    }

    pub(in crate::plugins) async fn set_restricted_async(
        self: &std::sync::Arc<Self>,
        db: Database,
        enabled: bool,
        cli: bool,
        owner: impl Send + 'static,
    ) -> AppResult<()> {
        let security = self.clone();
        admission::blocking(move |cancellation| {
            // Production callers retain their AppHandle/storage ownership even
            // when cancellation drops the command future before this worker.
            let _owner = owner;
            security.database(
                &db,
                |_| cancellation.check(),
                |policy, conn| {
                    cancellation.commit()?;
                    Self::restrict_on(policy, conn, enabled, cli, &security)
                },
            )
        })
        .await
    }

    fn restrict_on(
        policy: &mut Policy,
        conn: AppResult<&rusqlite::Connection>,
        enabled: bool,
        cli: bool,
        security: &Self,
    ) -> AppResult<()> {
        if !enabled && policy.cli_locked {
            return Err(AppError::validation("pluginSecurity.cliLocked"));
        }
        if policy.saved.restricted == enabled && (!cli || policy.cli_locked) {
            return Ok(());
        }
        let mut next = policy.saved.clone();
        next.restricted = enabled;
        // Fail closed when persistence is unavailable; never resume execution
        // after the user asked to enter restricted mode.
        let persisted = conn.and_then(|conn| save_on(conn, &next));
        if persisted.is_err() && !enabled {
            return persisted;
        }
        security.publish_restriction(policy, next, cli);
        persisted
    }

    fn publish_restriction(&self, policy: &mut Policy, next: Persisted, cli: bool) {
        let enabled = next.restricted;
        policy.saved = next;
        policy.cli_locked |= cli;
        if !enabled {
            policy.recovery_suggested = false;
        }
        policy.revision += 1;
        let generation = policy.revision;
        for grant in policy.saved.grants.values_mut() {
            grant.generation = generation;
        }
        policy.runtimes = dependencies::RuntimeDependencies::default();
        self.notify(policy);
    }

    /// A second-instance safe-mode request must close execution immediately;
    /// the async state emission persists the latest state in its retained worker.
    pub(in crate::plugins) fn lock_cli(&self) {
        let mut policy = self.policy();
        if policy.saved.restricted && policy.cli_locked {
            return;
        }
        let mut next = policy.saved.clone();
        next.restricted = true;
        self.publish_restriction(&mut policy, next, true);
    }

    #[cfg(test)]
    pub fn set_permissions(
        &self,
        db: &Database,
        id: &str,
        digest: String,
        declared: &[String],
        permissions: Option<Vec<String>>,
    ) -> AppResult<()> {
        self.set_permissions_with_cleanup(db, id, digest, declared, permissions, |_| {})
    }

    #[cfg(test)]
    pub(in crate::plugins) fn set_permissions_with_cleanup(
        &self,
        db: &Database,
        id: &str,
        digest: String,
        declared: &[String],
        permissions: Option<Vec<String>>,
        cleanup: impl FnOnce(Vec<RuntimeRetirement>),
    ) -> AppResult<()> {
        self.permissions_change(
            db,
            PermissionChange {
                id: id.to_owned(),
                digest,
                declared: declared.to_vec(),
                permissions,
            },
            None,
            cleanup,
        )
    }

    fn permissions_change(
        &self,
        db: &Database,
        change: PermissionChange,
        cancellation: Option<&crate::services::operations::Cancellation>,
        cleanup: impl FnOnce(Vec<RuntimeRetirement>),
    ) -> AppResult<()> {
        let PermissionChange {
            id,
            digest,
            declared,
            permissions,
        } = change;
        let id = id.as_str();
        if !crate::plugins::manifest::valid_id(id) {
            return Err(AppError::validation("plugin.notFound"));
        }
        let (persisted, retired) = self.database(
            db,
            |_| cancellation.map_or(Ok(()), |c| c.check()),
            |policy, conn| {
                if let Some(cancellation) = cancellation {
                    cancellation.commit()?;
                }
                let mut next = policy.saved.clone();
                if let Some(permissions) = permissions {
                    if permissions.len() > PERMISSIONS.len()
                        || permissions.iter().any(|permission| {
                            !PERMISSIONS.contains(&permission.as_str())
                                || !declared.contains(permission)
                        })
                    {
                        return Err(AppError::validation("pluginSecurity.permissionDenied"));
                    }
                    if next.grants.len() >= 256 && !next.grants.contains_key(id) {
                        return Err(AppError::validation("pluginSecurity.grantLimit"));
                    }
                    next.grants.insert(
                        id.into(),
                        Grant {
                            fingerprint: digest,
                            declared: normalized(&declared),
                            permissions: normalized(&permissions),
                            generation: policy.revision + 1,
                        },
                    );
                } else {
                    next.grants.remove(id);
                }
                let persisted = conn.and_then(|conn| save_on(conn, &next));
                let persisted = match persisted {
                    Err(error) if next.grants.contains_key(id) => return Err(error),
                    result => result,
                };
                policy.saved = next;
                let retired = dependencies::retire(policy, id);
                self.notify(policy);
                Ok((persisted, retired))
            },
        )?;
        cleanup(retired);
        persisted
    }

    pub(in crate::plugins) async fn permissions_async(
        self: &std::sync::Arc<Self>,
        db: Database,
        change: PermissionChange,
        cleanup: impl FnOnce(Vec<RuntimeRetirement>) + Send + 'static,
    ) -> AppResult<()> {
        let security = self.clone();
        admission::blocking(move |cancellation| {
            security.permissions_change(&db, change, Some(cancellation), cleanup)
        })
        .await
    }

    #[cfg(test)]
    pub fn mark_running(&self, db: &Database) -> AppResult<()> {
        self.database(db, |_| Ok(()), Self::running_on)
    }

    pub(in crate::plugins) fn mark_running_checked(
        &self,
        db: &Database,
        lease: &Lease,
        cancellation: &crate::services::operations::Cancellation,
    ) -> AppResult<()> {
        self.database(
            db,
            |policy| {
                cancellation.check()?;
                Self::authorize_lease(policy, lease, &[])
            },
            |policy, conn| {
                cancellation.commit()?;
                Self::running_on(policy, conn)
            },
        )
    }

    fn running_on(policy: &mut Policy, conn: AppResult<&rusqlite::Connection>) -> AppResult<()> {
        if policy.saved.restricted {
            return Err(AppError::validation("pluginSecurity.blocked"));
        }
        if policy.restarting {
            return Err(AppError::validation("pluginSecurity.changed"));
        }
        if !policy.saved.unclean {
            let mut next = policy.saved.clone();
            next.unclean = true;
            save_on(conn?, &next)?;
            policy.saved = next;
        }
        Ok(())
    }

    pub fn mark_clean(&self, db: &Database) -> AppResult<()> {
        self.database(
            db,
            |_| Ok(()),
            |policy, conn| {
                let mut next = policy.saved.clone();
                next.unclean = false;
                save_on(conn?, &next)?;
                policy.saved = next;
                Ok(())
            },
        )
    }
}
