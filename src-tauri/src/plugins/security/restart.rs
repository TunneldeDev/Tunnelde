use super::{save, AppError, AppResult, Database, PluginSecurity};

impl PluginSecurity {
    /// Windows installers exit the process without sending Tauri's Exit event.
    /// Persist a planned exit before handing control to the installer and keep
    /// plugin calls from marking the process unclean again during that handoff.
    pub fn with_planned_restart<T>(
        &self,
        db: &Database,
        restart: impl FnOnce() -> AppResult<T>,
    ) -> AppResult<T> {
        let _guard = RestartGuard::new(self, db)?;
        restart()
    }
}

struct RestartGuard<'a> {
    security: &'a PluginSecurity,
    db: &'a Database,
    was_unclean: bool,
}

impl<'a> RestartGuard<'a> {
    fn new(security: &'a PluginSecurity, db: &'a Database) -> AppResult<Self> {
        let mut policy = security.policy();
        if policy.restarting {
            return Err(AppError::validation("pluginSecurity.changed"));
        }
        let was_unclean = policy.saved.unclean;
        let mut next = policy.saved.clone();
        next.unclean = false;
        save(db, &next)?;
        policy.saved = next;
        policy.restarting = true;
        security.notify(&mut policy);
        Ok(Self {
            security,
            db,
            was_unclean,
        })
    }
}

impl Drop for RestartGuard<'_> {
    fn drop(&mut self) {
        // A successful handoff exits/restarts without returning. Reaching this
        // point means installation failed or was interrupted; retain crash
        // detection for the still-running application and allow plugin calls.
        let mut policy = self.security.policy();
        let mut next = policy.saved.clone();
        next.unclean |= self.was_unclean;
        if let Err(error) = save(self.db, &next) {
            tracing::error!(%error, "could not restore extension recovery marker after failed restart");
        }
        policy.saved = next;
        policy.restarting = false;
        self.security.notify(&mut policy);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::security::tests::grant;

    #[test]
    fn updater_handoff_is_clean_and_preserves_plugin_approvals() {
        let db = Database::in_memory().unwrap();
        let security = PluginSecurity::default();
        security.initialize(&db, false).unwrap();
        let lease = grant(&security, &db, "sample", &["log"]);
        security.mark_running(&db).unwrap();

        security
            .with_planned_restart(&db, || {
                // Model the new process reading SQLite after the updater exits
                // directly, with no RunEvent::Exit or Rust destructors.
                let next_process = PluginSecurity::default();
                next_process.initialize(&db, false)?;
                let state = next_process.snapshot(&[]);
                assert!(!state.restricted);
                assert!(!state.recovery_suggested);
                assert!(!state.cli_locked);
                assert!(next_process
                    .authorize(
                        &lease.id,
                        &lease.fingerprint,
                        &lease.permissions,
                        Some("log"),
                        None,
                    )
                    .is_ok());
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn plugin_calls_cannot_rewrite_the_marker_during_installer_handoff() {
        let db = Database::in_memory().unwrap();
        let security = PluginSecurity::default();
        let lease = grant(&security, &db, "sample", &["log"]);
        security.mark_running(&db).unwrap();
        security
            .with_planned_restart(&db, || {
                assert!(security.mark_running(&db).is_err());
                assert!(security
                    .authorize(
                        &lease.id,
                        &lease.fingerprint,
                        &lease.permissions,
                        Some("log"),
                        Some(lease.generation),
                    )
                    .is_err());
                assert!(security.with_planned_restart(&db, || Ok(())).is_err());
                let next_process = PluginSecurity::default();
                next_process.initialize(&db, false)?;
                assert!(!next_process.snapshot(&[]).recovery_suggested);
                Ok(())
            })
            .unwrap();
        assert!(security.mark_running(&db).is_ok());
        assert!(security
            .authorize(
                &lease.id,
                &lease.fingerprint,
                &lease.permissions,
                Some("log"),
                Some(lease.generation),
            )
            .is_ok());
    }

    #[test]
    fn failed_install_restores_crash_detection_without_inventing_plugin_activity() {
        for was_running in [false, true] {
            let db = Database::in_memory().unwrap();
            let security = PluginSecurity::default();
            security.initialize(&db, false).unwrap();
            if was_running {
                security.mark_running(&db).unwrap();
            }
            let result: AppResult<()> = security
                .with_planned_restart(&db, || Err(AppError::Update("installer failed".into())));
            assert!(result.is_err());
            assert!(!security.policy().restarting);
            let next_process = PluginSecurity::default();
            next_process.initialize(&db, false).unwrap();
            assert_eq!(next_process.snapshot(&[]).recovery_suggested, was_running);
            assert_eq!(next_process.snapshot(&[]).restricted, was_running);
        }
    }

    #[test]
    fn planned_restart_preserves_explicit_restricted_mode_and_cli_lock() {
        for cli_locked in [false, true] {
            let db = Database::in_memory().unwrap();
            let security = PluginSecurity::default();
            security.initialize(&db, cli_locked).unwrap();
            security.set_restricted(&db, true, cli_locked).unwrap();
            security
                .with_planned_restart(&db, || {
                    let current = security.snapshot(&[]);
                    assert!(current.restricted);
                    assert_eq!(current.cli_locked, cli_locked);
                    let next_process = PluginSecurity::default();
                    next_process.initialize(&db, cli_locked)?;
                    let next = next_process.snapshot(&[]);
                    assert!(next.restricted);
                    assert_eq!(next.cli_locked, cli_locked);
                    assert!(!next.recovery_suggested);
                    Ok(())
                })
                .unwrap();
            assert!(security.snapshot(&[]).restricted);
        }
    }

    #[test]
    fn failed_install_does_not_undo_security_changes_made_during_the_handoff() {
        let db = Database::in_memory().unwrap();
        let security = PluginSecurity::default();
        let lease = grant(&security, &db, "sample", &["log"]);
        security.mark_running(&db).unwrap();
        let result: AppResult<()> = security.with_planned_restart(&db, || {
            security.set_permissions(&db, &lease.id, String::new(), &[], None)?;
            security.set_restricted(&db, true, false)?;
            Err(AppError::Update("installer failed".into()))
        });
        assert!(result.is_err());
        let next_process = PluginSecurity::default();
        next_process.initialize(&db, false).unwrap();
        assert!(next_process.snapshot(&[]).restricted);
        next_process.set_restricted(&db, false, false).unwrap();
        assert!(next_process
            .authorize(
                &lease.id,
                &lease.fingerprint,
                &lease.permissions,
                None,
                None
            )
            .is_err());
    }

    #[test]
    fn persistence_failure_prevents_starting_the_installer() {
        let db = Database::in_memory().unwrap();
        let security = PluginSecurity::default();
        security.initialize(&db, false).unwrap();
        security.mark_running(&db).unwrap();
        db.with(|conn| {
            conn.pragma_update(None, "query_only", true)?;
            Ok(())
        })
        .unwrap();
        assert!(security
            .with_planned_restart(&db, || -> AppResult<()> {
                panic!("installer must not run without a persisted clean exit")
            })
            .is_err());
        assert!(!security.policy().restarting);
        let next_process = PluginSecurity::default();
        assert!(next_process.initialize(&db, false).is_err());
        assert!(next_process.snapshot(&[]).recovery_suggested);
    }
}
