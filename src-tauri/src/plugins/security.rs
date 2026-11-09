use std::collections::{BTreeMap, BTreeSet};
use std::future::Future;
use std::path::Path;
use std::sync::Mutex;

use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::watch;

use crate::db::Database;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

mod package;
mod restart;

pub(super) use package::{frontend_snapshot, FrontendSnapshot};

pub const EVENT: &str = "plugin:security-changed";
pub const PERMISSIONS: &[&str] = &[
    "ui.trusted",
    "log",
    "app.read",
    "settings.read",
    "settings.write",
    "hosts.read",
    "hosts.write",
    "sessions.read",
    "ssh.exec",
    "fs.read",
    "fs.write",
    "sftp.read",
    "sftp.write",
    "monitor.read",
    "monitor.write",
    "history.read",
    "history.write",
    "workspace.read",
    "workspace.write",
    "editor.read",
    "editor.write",
    "clipboard.read",
    "clipboard.write",
    "app.openExternal",
    "network",
    "process.exec",
    "secrets",
    "mounts.read",
    "mounts.write",
    "forwards.read",
    "forwards.write",
];

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
struct Grant {
    fingerprint: String,
    declared: Vec<String>,
    permissions: Vec<String>,
    #[serde(skip)]
    generation: u64,
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
struct Persisted {
    restricted: bool,
    unclean: bool,
    grants: BTreeMap<String, Grant>,
}

#[derive(Default)]
struct Policy {
    saved: Persisted,
    cli_locked: bool,
    recovery_suggested: bool,
    restarting: bool,
    revision: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecurityState {
    pub restricted: bool,
    pub cli_locked: bool,
    pub recovery_suggested: bool,
    pub reason: Option<String>,
    pub grants: BTreeMap<String, Vec<String>>,
}

#[derive(Clone)]
pub struct Lease {
    pub id: String,
    pub fingerprint: String,
    pub permissions: Vec<String>,
    pub generation: u64,
}

pub struct PluginSecurity {
    inner: Mutex<Policy>,
    changed: watch::Sender<u64>,
}

impl Default for PluginSecurity {
    fn default() -> Self {
        let (changed, _) = watch::channel(0);
        Self {
            inner: Mutex::new(Policy::default()),
            changed,
        }
    }
}

pub fn cli_restricted(args: impl IntoIterator<Item = impl AsRef<str>>) -> bool {
    args.into_iter()
        .any(|arg| matches!(arg.as_ref(), "--safe-mode" | "--restricted-mode"))
}

fn normalized(values: &[String]) -> Vec<String> {
    values
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn valid_saved(saved: &Persisted) -> bool {
    saved.grants.len() <= 256
        && saved.grants.iter().all(|(id, grant)| {
            super::manifest::valid_id(id)
                && grant.fingerprint.len() == 64
                && grant.fingerprint.bytes().all(|c| c.is_ascii_hexdigit())
                && grant.declared.len() <= PERMISSIONS.len()
                && grant.permissions.len() <= PERMISSIONS.len()
                && grant
                    .declared
                    .iter()
                    .all(|permission| PERMISSIONS.contains(&permission.as_str()))
                && grant
                    .permissions
                    .iter()
                    .all(|permission| grant.declared.contains(permission))
        })
}

fn save(db: &Database, saved: &Persisted) -> AppResult<()> {
    db.with(|conn| {
        conn.execute("INSERT INTO settings (key,value,updated_at) VALUES ('plugin_security',?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
            rusqlite::params![serde_json::to_string(saved)?, crate::models::now_ms()])?;
        Ok(())
    })
}

impl PluginSecurity {
    fn policy(&self) -> std::sync::MutexGuard<'_, Policy> {
        self.inner.lock().unwrap_or_else(|error| error.into_inner())
    }

    fn notify(&self, policy: &mut Policy) {
        policy.revision = policy.revision.wrapping_add(1);
        self.changed.send_replace(policy.revision);
    }

    pub fn initialize(&self, db: &Database, locked: bool) -> AppResult<()> {
        let raw: Option<String> = db.with(|conn| {
            Ok(conn
                .query_row(
                    "SELECT value FROM settings WHERE key='plugin_security'",
                    [],
                    |row| row.get(0),
                )
                .optional()?)
        })?;
        let corrupt = raw.as_ref().is_some_and(|value| {
            value.len() > 512 * 1024
                || serde_json::from_str::<Persisted>(value)
                    .map_or(true, |saved| !valid_saved(&saved))
        });
        let mut saved = raw
            .filter(|value| value.len() <= 512 * 1024)
            .and_then(|value| serde_json::from_str::<Persisted>(&value).ok())
            .filter(valid_saved)
            .unwrap_or_default();
        let recovery = saved.unclean || corrupt;
        saved.restricted |= locked || recovery;
        let mut policy = self.policy();
        policy.cli_locked = locked;
        policy.recovery_suggested = recovery;
        for grant in saved.grants.values_mut() {
            policy.revision += 1;
            grant.generation = policy.revision;
        }
        policy.saved = saved;
        self.notify(&mut policy);
        save(db, &policy.saved)
    }

    pub fn snapshot(&self, identities: &[(String, String, Vec<String>)]) -> SecurityState {
        let policy = self.policy();
        let grants = identities
            .iter()
            .filter_map(|(id, digest, declared)| {
                policy
                    .saved
                    .grants
                    .get(id)
                    .filter(|grant| {
                        grant.fingerprint == *digest && grant.declared == normalized(declared)
                    })
                    .map(|grant| (id.clone(), grant.permissions.clone()))
            })
            .collect();
        SecurityState {
            restricted: policy.saved.restricted,
            cli_locked: policy.cli_locked,
            recovery_suggested: policy.recovery_suggested,
            reason: if policy.cli_locked {
                Some("pluginSecurity.cliReason".into())
            } else if policy.recovery_suggested {
                Some("pluginSecurity.recoveryReason".into())
            } else {
                None
            },
            grants,
        }
    }

    pub fn authorize(
        &self,
        id: &str,
        digest: &str,
        declared: &[String],
        permission: Option<&str>,
        generation: Option<u64>,
    ) -> AppResult<u64> {
        let policy = self.policy();
        Self::authorize_policy(&policy, id, digest, declared, permission, generation)
    }

    fn authorize_policy(
        policy: &Policy,
        id: &str,
        digest: &str,
        declared: &[String],
        permission: Option<&str>,
        generation: Option<u64>,
    ) -> AppResult<u64> {
        if policy.saved.restricted {
            return Err(AppError::validation("pluginSecurity.blocked"));
        }
        if policy.restarting {
            return Err(AppError::validation("pluginSecurity.changed"));
        }
        let grant = policy
            .saved
            .grants
            .get(id)
            .filter(|grant| grant.fingerprint == digest && grant.declared == normalized(declared))
            .ok_or_else(|| AppError::validation("pluginSecurity.approvalRequired"))?;
        if generation.is_some_and(|value| value != grant.generation) {
            return Err(AppError::validation("pluginSecurity.changed"));
        }
        if permission.is_some_and(|permission| {
            !declared.iter().any(|value| value == permission)
                || !grant.permissions.iter().any(|value| value == permission)
        }) {
            return Err(AppError::validation("pluginSecurity.permissionDenied"));
        }
        Ok(grant.generation)
    }

    /// Linearize bounded synchronous mutations with revocation. Lock order is
    /// policy -> metadata -> database, matching permission persistence. The
    /// callback must not reenter security, await, or perform external I/O.
    pub(super) fn with_authorized<T>(
        &self,
        lease: &Lease,
        permissions: &[&str],
        operation: impl FnOnce() -> AppResult<T>,
    ) -> AppResult<T> {
        let policy = self.policy();
        Self::authorize_policy(
            &policy,
            &lease.id,
            &lease.fingerprint,
            &lease.permissions,
            None,
            Some(lease.generation),
        )?;
        for permission in permissions {
            Self::authorize_policy(
                &policy,
                &lease.id,
                &lease.fingerprint,
                &lease.permissions,
                Some(permission),
                Some(lease.generation),
            )?;
        }
        let result = operation();
        drop(policy);
        result
    }

    pub fn lease(&self, id: &str, digest: String, declared: Vec<String>) -> AppResult<Lease> {
        let generation = self.authorize(id, &digest, &declared, None, None)?;
        Ok(Lease {
            id: id.into(),
            fingerprint: digest,
            permissions: declared,
            generation,
        })
    }

    pub async fn guard<T>(
        &self,
        lease: &Lease,
        operation: impl Future<Output = AppResult<T>>,
    ) -> AppResult<T> {
        let mut changed = self.changed.subscribe();
        let check = || {
            self.authorize(
                &lease.id,
                &lease.fingerprint,
                &lease.permissions,
                None,
                Some(lease.generation),
            )
        };
        check()?;
        tokio::pin!(operation);
        loop {
            tokio::select! {
                biased;
                _ = changed.changed() => { check()?; }
                result = &mut operation => { check()?; return result; }
            }
        }
    }

    pub fn set_restricted(&self, db: &Database, enabled: bool, cli: bool) -> AppResult<()> {
        let mut policy = self.policy();
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
        let persisted = save(db, &next);
        if persisted.is_err() && !enabled {
            return persisted;
        }
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
        self.notify(&mut policy);
        persisted
    }

    pub fn set_permissions(
        &self,
        db: &Database,
        id: &str,
        digest: String,
        declared: &[String],
        permissions: Option<Vec<String>>,
    ) -> AppResult<()> {
        if !super::manifest::valid_id(id) {
            return Err(AppError::validation("plugin.notFound"));
        }
        let mut policy = self.policy();
        let mut next = policy.saved.clone();
        if let Some(permissions) = permissions {
            if permissions.len() > PERMISSIONS.len()
                || permissions.iter().any(|permission| {
                    !PERMISSIONS.contains(&permission.as_str()) || !declared.contains(permission)
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
                    declared: normalized(declared),
                    permissions: normalized(&permissions),
                    generation: policy.revision + 1,
                },
            );
        } else {
            next.grants.remove(id);
        }
        let persisted = save(db, &next);
        if persisted.is_err() && next.grants.contains_key(id) {
            return persisted;
        }
        policy.saved = next;
        self.notify(&mut policy);
        persisted
    }

    pub fn mark_running(&self, db: &Database) -> AppResult<()> {
        let mut policy = self.policy();
        if policy.saved.restricted {
            return Err(AppError::validation("pluginSecurity.blocked"));
        }
        if policy.restarting {
            return Err(AppError::validation("pluginSecurity.changed"));
        }
        if !policy.saved.unclean {
            let mut next = policy.saved.clone();
            next.unclean = true;
            save(db, &next)?;
            policy.saved = next;
        }
        Ok(())
    }

    pub fn mark_clean(&self, db: &Database) -> AppResult<()> {
        let mut policy = self.policy();
        let mut next = policy.saved.clone();
        next.unclean = false;
        save(db, &next)?;
        policy.saved = next;
        Ok(())
    }

    pub fn invalidate(&self, id: &str) {
        let mut policy = self.policy();
        policy.saved.grants.remove(id);
        self.notify(&mut policy);
    }

    pub fn invalidate_runtimes(&self) {
        let mut policy = self.policy();
        policy.revision += 1;
        let generation = policy.revision;
        for grant in policy.saved.grants.values_mut() {
            grant.generation = generation;
        }
        self.notify(&mut policy);
    }

    pub fn invalidate_runtime(&self, id: &str) {
        let mut policy = self.policy();
        policy.revision += 1;
        let generation = policy.revision;
        if let Some(grant) = policy.saved.grants.get_mut(id) {
            grant.generation = generation;
        }
        self.notify(&mut policy);
    }

    pub fn cleanup_boundary(&self, id: &str) -> u64 {
        let policy = self.policy();
        policy
            .saved
            .grants
            .get(id)
            .map_or(policy.revision, |grant| grant.generation)
    }

    pub fn persist(&self, db: &Database) -> AppResult<()> {
        save(db, &self.policy().saved)
    }
}

/// Hash paths and every installed byte, with the same resource bounds as ZIP
/// installation. Symlinks and special files cannot be silently trusted.
pub fn fingerprint(root: &Path) -> AppResult<String> {
    package::fingerprint(root)
}

pub async fn fingerprint_async(root: std::path::PathBuf) -> AppResult<String> {
    tokio::task::spawn_blocking(move || fingerprint(&root))
        .await
        .map_err(|_| AppError::internal("pluginSecurity.packageInvalid"))?
}

pub async fn emit_state(app: &AppHandle) {
    let state = app.state::<AppState>();
    if let Err(error) = state.plugins.security.persist(&state.db) {
        tracing::warn!(%error, "could not persist extension security state");
    }
    let _ = app.emit(EVENT, state.plugins.security_state().await);
}

#[tauri::command]
pub async fn plugin_security_state(app: AppHandle) -> SecurityState {
    app.state::<AppState>().plugins.security_state().await
}

#[tauri::command]
pub async fn plugin_set_restricted(app: AppHandle, enabled: bool) -> AppResult<SecurityState> {
    let state = app.state::<AppState>();
    let result = state
        .plugins
        .security
        .set_restricted(&state.db, enabled, false);
    if enabled {
        state.plugins.stop_all_immediately(&app).await;
    }
    emit_state(&app).await;
    result?;
    Ok(state.plugins.security_state().await)
}

#[tauri::command]
pub async fn plugin_set_permissions(
    app: AppHandle,
    id: String,
    permissions: Option<Vec<String>>,
    expected_fingerprint: Option<String>,
) -> AppResult<()> {
    let state = app.state::<AppState>();
    let result = state
        .plugins
        .set_permissions(&state.db, &id, permissions, expected_fingerprint)
        .await;
    // A grant change invalidates every pending call from the previous process.
    // Kill directly rather than waiting for its shutdown handler.
    let _ = state.plugins.stop_immediately(&app, &id).await;
    emit_state(&app).await;
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::time::Duration;

    const DIGEST: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    #[test]
    fn synchronous_mutation_checks_all_permissions_and_serializes_revocation() {
        let db = Arc::new(Database::in_memory().unwrap());
        let security = Arc::new(PluginSecurity::default());
        let lease = grant(&security, &db, "fields", &["hosts.read", "hosts.write"]);
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let (finish_tx, finish_rx) = std::sync::mpsc::channel();
        let writer = {
            let (security, lease) = (security.clone(), lease.clone());
            std::thread::spawn(move || {
                security.with_authorized(&lease, &["hosts.read", "hosts.write"], || {
                    entered_tx.send(()).unwrap();
                    finish_rx.recv().unwrap();
                    Ok(())
                })
            })
        };
        entered_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        let (revoked_tx, revoked_rx) = std::sync::mpsc::channel();
        let revoker = {
            let (security, db) = (security.clone(), db.clone());
            std::thread::spawn(move || {
                security
                    .set_permissions(&db, "fields", String::new(), &[], None)
                    .unwrap();
                revoked_tx.send(()).unwrap();
            })
        };
        assert!(revoked_rx.recv_timeout(Duration::from_millis(20)).is_err());
        finish_tx.send(()).unwrap();
        writer.join().unwrap().unwrap();
        revoker.join().unwrap();
        assert!(security
            .with_authorized::<()>(&lease, &["hosts.read"], || panic!(
                "revoked operation executed"
            ))
            .is_err());
        let readonly = grant(&security, &db, "read", &["hosts.read"]);
        assert!(security
            .with_authorized::<()>(&readonly, &["hosts.read", "hosts.write"], || panic!(
                "ungranted operation executed"
            ))
            .is_err());
    }

    pub(super) fn grant(
        security: &PluginSecurity,
        db: &Database,
        id: &str,
        permissions: &[&str],
    ) -> Lease {
        let permissions: Vec<String> = permissions.iter().map(|value| (*value).into()).collect();
        security
            .set_permissions(
                db,
                id,
                DIGEST.into(),
                &permissions,
                Some(permissions.clone()),
            )
            .unwrap();
        security.lease(id, DIGEST.into(), permissions).unwrap()
    }

    #[test]
    fn empty_consent_is_distinct_from_missing_and_grants_bind_content_and_declarations() {
        let db = Database::in_memory().unwrap();
        let security = PluginSecurity::default();
        assert!(security.authorize("zero", DIGEST, &[], None, None).is_err());
        let lease = grant(&security, &db, "zero", &[]);
        assert!(security
            .authorize("zero", DIGEST, &[], None, Some(lease.generation))
            .is_ok());
        assert!(security
            .authorize("zero", DIGEST, &["log".into()], None, None)
            .is_err());
        assert!(security
            .authorize("zero", &"b".repeat(64), &[], None, None)
            .is_err());
        assert!(security
            .authorize("zero", DIGEST, &[], Some("log"), None)
            .is_err());
        security
            .set_permissions(&db, "zero", String::new(), &[], None)
            .unwrap();
        assert!(security.authorize("zero", DIGEST, &[], None, None).is_err());
    }

    #[test]
    fn permissions_require_both_manifest_declaration_and_explicit_grant() {
        let db = Database::in_memory().unwrap();
        let security = PluginSecurity::default();
        let declared = vec!["log".into(), "clipboard.read".into()];
        security
            .set_permissions(
                &db,
                "sample",
                DIGEST.into(),
                &declared,
                Some(vec!["log".into()]),
            )
            .unwrap();
        assert!(security
            .authorize("sample", DIGEST, &declared, Some("log"), None)
            .is_ok());
        assert!(security
            .authorize("sample", DIGEST, &declared, Some("clipboard.read"), None)
            .is_err());
        assert!(security
            .set_permissions(
                &db,
                "sample",
                DIGEST.into(),
                &declared,
                Some(vec!["fs.write".into()])
            )
            .is_err());
        assert!(security
            .set_permissions(
                &db,
                "sample",
                DIGEST.into(),
                &declared,
                Some(vec!["anything".into()])
            )
            .is_err());
    }

    #[test]
    fn restrictions_and_regrant_never_resurrect_a_previous_process() {
        let db = Database::in_memory().unwrap();
        let security = PluginSecurity::default();
        let old = grant(&security, &db, "sample", &["log"]);
        security.set_restricted(&db, false, false).unwrap();
        assert!(security
            .authorize(
                "sample",
                DIGEST,
                &old.permissions,
                None,
                Some(old.generation)
            )
            .is_ok());
        security.set_restricted(&db, true, false).unwrap();
        assert!(security
            .authorize("sample", DIGEST, &old.permissions, None, None)
            .is_err());
        security.set_restricted(&db, false, false).unwrap();
        assert!(security
            .authorize(
                "sample",
                DIGEST,
                &old.permissions,
                None,
                Some(old.generation)
            )
            .is_err());
        let current = security
            .lease("sample", DIGEST.into(), old.permissions.clone())
            .unwrap();
        security.invalidate("sample");
        let replacement = grant(&security, &db, "sample", &["log"]);
        assert_ne!(current.generation, replacement.generation);
        assert!(security
            .authorize(
                "sample",
                DIGEST,
                &old.permissions,
                None,
                Some(current.generation)
            )
            .is_err());
    }

    #[test]
    fn cleanup_boundary_excludes_replacement_and_unrelated_runtime_generations() {
        let db = Database::in_memory().unwrap();
        let security = PluginSecurity::default();
        let old = grant(&security, &db, "one", &[]);
        security.invalidate_runtime("one");
        let boundary = security.cleanup_boundary("one");
        assert!(old.generation < boundary);
        let replacement = security.lease("one", DIGEST.into(), vec![]).unwrap();
        assert_eq!(replacement.generation, boundary);
        grant(&security, &db, "two", &[]);
        assert_eq!(security.cleanup_boundary("one"), boundary);
        security.invalidate("one");
        assert!(security.cleanup_boundary("one") > replacement.generation);
    }

    #[tokio::test]
    async fn revocation_cancels_a_long_operation_without_waiting_for_its_instance_lock() {
        let db = Database::in_memory().unwrap();
        let security = Arc::new(PluginSecurity::default());
        let lease = grant(&security, &db, "sample", &[]);
        let instance_lock = Arc::new(tokio::sync::Mutex::new(()));
        let (ready, started) = tokio::sync::oneshot::channel();
        let task_security = security.clone();
        let task_lock = instance_lock.clone();
        let operation = tokio::spawn(async move {
            let _guard = task_lock.lock().await;
            task_security
                .guard(&lease, async {
                    let _ = ready.send(());
                    std::future::pending::<AppResult<()>>().await
                })
                .await
        });
        started.await.unwrap();
        security
            .set_permissions(&db, "sample", String::new(), &[], None)
            .unwrap();
        assert!(tokio::time::timeout(Duration::from_millis(200), operation)
            .await
            .unwrap()
            .unwrap()
            .is_err());
        assert!(instance_lock.try_lock().is_ok());
    }

    #[tokio::test]
    async fn unrelated_grants_preserve_a_running_operation_and_stop_invalidates_its_lease() {
        let db = Database::in_memory().unwrap();
        let security = Arc::new(PluginSecurity::default());
        let lease = grant(&security, &db, "one", &[]);
        let (send, receive) = tokio::sync::oneshot::channel();
        let task_security = security.clone();
        let old = lease.clone();
        let task = tokio::spawn(async move {
            task_security
                .guard(&old, async {
                    receive
                        .await
                        .map_err(|_| AppError::internal("test channel"))
                })
                .await
        });
        grant(&security, &db, "two", &["log"]);
        send.send(42).unwrap();
        assert_eq!(task.await.unwrap().unwrap(), 42);
        security.invalidate_runtime("one");
        assert!(security
            .authorize("one", DIGEST, &[], None, Some(lease.generation))
            .is_err());
        assert!(security
            .authorize("two", DIGEST, &["log".into()], None, None)
            .is_ok());
    }

    #[test]
    fn cli_lock_cannot_be_disabled_and_crash_recovery_clears_only_after_clean_exit() {
        assert!(cli_restricted(["tunnelde", "--safe-mode"]));
        assert!(cli_restricted(["--restricted-mode"]));
        assert!(!cli_restricted(["--safe-mode-false", "some--safe-mode"]));
        let db = Database::in_memory().unwrap();
        let first = PluginSecurity::default();
        first.initialize(&db, false).unwrap();
        grant(&first, &db, "sample", &[]);
        first.mark_running(&db).unwrap();
        let recovered = PluginSecurity::default();
        recovered.initialize(&db, false).unwrap();
        let state = recovered.snapshot(&[]);
        assert!(state.restricted && state.recovery_suggested && !state.cli_locked);
        recovered.set_restricted(&db, false, false).unwrap();
        recovered.mark_clean(&db).unwrap();
        let clean = PluginSecurity::default();
        clean.initialize(&db, true).unwrap();
        assert!(clean.snapshot(&[]).cli_locked);
        assert!(!clean.snapshot(&[]).recovery_suggested);
        assert!(clean.set_restricted(&db, false, false).is_err());
    }

    #[test]
    fn malformed_security_settings_fail_closed_and_snapshots_hide_stale_grants() {
        let db = Database::in_memory().unwrap();
        db.with(|conn| { conn.execute("INSERT INTO settings (key,value,updated_at) VALUES ('plugin_security','invalid',0)", [])?; Ok(()) }).unwrap();
        let security = PluginSecurity::default();
        security.initialize(&db, false).unwrap();
        assert!(security.snapshot(&[]).restricted);
        security.set_restricted(&db, false, false).unwrap();
        grant(&security, &db, "sample", &[]);
        assert!(security
            .snapshot(&[("sample".into(), "b".repeat(64), vec![])])
            .grants
            .is_empty());
        let current = security.snapshot(&[("sample".into(), DIGEST.into(), vec![])]);
        assert_eq!(current.grants.get("sample"), Some(&vec![]));
    }

    #[test]
    fn fingerprint_detects_content_paths_and_resource_limits() {
        let directory =
            std::env::temp_dir().join(format!("tunnelde-security-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(directory.join("index.js"), "aaaa").unwrap();
        let first = fingerprint(&directory).unwrap();
        assert_eq!(first, fingerprint(&directory).unwrap());
        std::fs::write(directory.join("index.js"), "bbbb").unwrap();
        let second = fingerprint(&directory).unwrap();
        assert_ne!(first, second);
        std::fs::rename(directory.join("index.js"), directory.join("other.js")).unwrap();
        assert_ne!(second, fingerprint(&directory).unwrap());
        let oversized = std::fs::File::create(directory.join("oversized")).unwrap();
        oversized.set_len(64 * 1024 * 1024 + 1).unwrap();
        assert!(fingerprint(&directory).is_err());
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn persistence_failure_still_restricts_and_revokes_but_cannot_enable_execution() {
        let db = Database::in_memory().unwrap();
        let security = PluginSecurity::default();
        grant(&security, &db, "sample", &[]);
        db.with(|conn| {
            conn.pragma_update(None, "query_only", true)?;
            Ok(())
        })
        .unwrap();
        assert!(security
            .set_permissions(&db, "sample", String::new(), &[], None)
            .is_err());
        assert!(security
            .authorize("sample", DIGEST, &[], None, None)
            .is_err());
        assert!(security.set_restricted(&db, true, false).is_err());
        assert!(security.snapshot(&[]).restricted);
        assert!(security.set_restricted(&db, false, false).is_err());
        assert!(security.snapshot(&[]).restricted);
    }
}
