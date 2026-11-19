//! Shared host-owned transports. UI contributors never own or duplicate them.
use super::{
    contract::{Entry, Group, Rule},
    repository,
};
use crate::{
    error::{AppError, AppResult},
    plugins::security::Lease,
    ssh::{SessionInfo, SshConnectRequest},
    state::AppState,
};
use serde::Serialize;
use std::{
    collections::{BTreeMap, HashMap},
    sync::{Arc, Mutex, Weak},
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{Mutex as AsyncMutex, Notify, OwnedMutexGuard};

mod recovery;
pub(super) use recovery::retryable;
pub(crate) use recovery::{launch, shutdown};

pub(crate) const OWNER: &str = "@tunnelde/mount-rules";

#[derive(Clone)]
pub(crate) struct Authority(pub Option<Lease>);
impl Authority {
    pub(crate) fn check(&self, app: &AppHandle) -> AppResult<()> {
        self.commit(app, || Ok(()))
    }
    pub(crate) fn commit<T>(
        &self,
        app: &AppHandle,
        effect: impl FnOnce() -> AppResult<T>,
    ) -> AppResult<T> {
        let state = app.state::<AppState>();
        let _admission = state
            .mount_runtime
            .admission
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if state
            .mount_runtime
            .shutting_down
            .load(std::sync::atomic::Ordering::Acquire)
        {
            return Err(AppError::validation("mounts.operations.cancelled"));
        }
        if let Some(lease) = &self.0 {
            app.state::<AppState>().plugins.security.with_authorized(
                lease,
                &["mounts.write"],
                effect,
            )
        } else {
            effect()
        }
    }
}
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleStatus {
    pub rule_id: String,
    pub revision: String,
    pub group_id: String,
    pub phase: String,
    pub runtime_id: Option<String>,
    pub session_id: Option<String>,
    pub error: Option<serde_json::Value>,
    pub desired: bool,
}
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionStatus {
    pub group_id: String,
    pub host_id: String,
    pub phase: String,
    pub session_id: Option<String>,
    pub connected_at: Option<i64>,
    pub retry_at: Option<i64>,
    pub error: Option<serde_json::Value>,
}
struct Connection {
    app: AppHandle,
    info: SessionInfo,
}
impl Drop for Connection {
    fn drop(&mut self) {
        let _ = crate::ssh::disconnect(&self.app, &self.info.id);
    }
}
#[derive(Default)]
struct Book {
    rules: BTreeMap<String, RuleStatus>,
    connections: BTreeMap<String, (ConnectionStatus, Option<Arc<Connection>>)>,
    pins: HashMap<String, crate::ssh::session::review::Review>,
}
pub(crate) struct Coordinator {
    book: Mutex<Book>,
    admission: Mutex<()>,
    boot: String,
    sequence: std::sync::atomic::AtomicU64,
    gates: Mutex<HashMap<String, Weak<AsyncMutex<()>>>>,
    pub(crate) changed: Notify,
    pub(crate) operations: super::operations::Registry,
    pub(crate) shutting_down: std::sync::atomic::AtomicBool,
}
impl Default for Coordinator {
    fn default() -> Self {
        Self {
            book: Mutex::default(),
            admission: Mutex::default(),
            boot: uuid::Uuid::new_v4().to_string(),
            sequence: Default::default(),
            gates: Mutex::default(),
            changed: Notify::new(),
            operations: Default::default(),
            shutting_down: Default::default(),
        }
    }
}
impl Coordinator {
    fn lock(&self) -> std::sync::MutexGuard<'_, Book> {
        self.book.lock().unwrap_or_else(|e| e.into_inner())
    }
    pub(crate) fn revision(&self) -> String {
        format!(
            "{}:{}",
            self.boot,
            self.sequence.load(std::sync::atomic::Ordering::Acquire)
        )
    }
    pub(crate) fn release_connections(&self) {
        let connections = std::mem::take(&mut self.lock().connections);
        drop(connections);
    }
    pub(crate) fn forget_rule(&self, id: &str) {
        self.lock().rules.remove(id);
    }
    pub(crate) fn forget_group(&self, id: &str) {
        let mut book = self.lock();
        book.rules.retain(|_, r| r.group_id != id);
        book.pins.remove(id);
        let old = book.connections.remove(id);
        drop(book);
        drop(old);
    }
    pub(crate) fn gate(&self, group: &str) -> AppResult<OwnedMutexGuard<()>> {
        let mut gates = self.gates.lock().unwrap_or_else(|e| e.into_inner());
        gates.retain(|_, gate| gate.strong_count() > 0);
        let gate = gates.get(group).and_then(Weak::upgrade).unwrap_or_else(|| {
            let gate = Arc::new(AsyncMutex::new(()));
            gates.insert(group.into(), Arc::downgrade(&gate));
            gate
        });
        gate.try_lock_owned()
            .map_err(|_| AppError::validation("mounts.operations.busy"))
    }
    pub(crate) fn rule_states(&self) -> Vec<RuleStatus> {
        self.lock().rules.values().cloned().collect()
    }
    pub(crate) fn connection_states(&self) -> Vec<ConnectionStatus> {
        self.lock()
            .connections
            .values()
            .map(|(status, _)| status.clone())
            .collect()
    }
    fn group_for_session(&self, session: &str) -> Option<String> {
        self.lock()
            .connections
            .iter()
            .find(|(_, (status, _))| status.session_id.as_deref() == Some(session))
            .map(|(id, _)| id.clone())
    }
    pub(crate) fn inactive(&self, id: &str) -> AppResult<()> {
        if self
            .lock()
            .rules
            .get(id)
            .is_some_and(|s| s.runtime_id.is_some() || s.desired || s.phase == "starting")
        {
            return Err(AppError::validation("mounts.rules.stopBeforeEdit"));
        }
        Ok(())
    }
    pub(crate) fn group_inactive(&self, id: &str) -> AppResult<()> {
        let book = self.lock();
        if book.connections.get(id).is_some_and(|(_, c)| c.is_some())
            || book
                .rules
                .values()
                .any(|s| s.group_id == id && (s.desired || s.runtime_id.is_some()))
        {
            return Err(AppError::validation("mounts.rules.stopBeforeEdit"));
        }
        Ok(())
    }
}
pub(crate) fn changed(app: &AppHandle) {
    let state = app.state::<AppState>();
    state
        .mount_runtime
        .sequence
        .fetch_add(1, std::sync::atomic::Ordering::AcqRel);
    state.mount_runtime.changed.notify_waiters();
    let _ = app.emit("mounts://changed", ());
    let _ = app.emit(
        "plugin://domain-changed",
        serde_json::json!({"domain":"mounts"}),
    );
}
fn rule_state(
    app: &AppHandle,
    rule: &Entry<Rule>,
    phase: &str,
    mount: Option<&crate::mounts::MountInfo>,
    error: Option<&AppError>,
    desired: bool,
) {
    app.state::<AppState>().mount_runtime.lock().rules.insert(
        rule.value.id.clone(),
        RuleStatus {
            rule_id: rule.value.id.clone(),
            revision: rule.revision.clone(),
            group_id: rule.value.group_id.clone(),
            phase: phase.into(),
            runtime_id: mount.map(|m| m.id.clone()),
            session_id: mount.map(|m| m.session_id.clone()),
            error: error.map(super::operations::error_value),
            desired,
        },
    );
    changed(app);
}
pub(crate) fn adopt_state(app: &AppHandle, rule: &Entry<Rule>, mount: &crate::mounts::MountInfo) {
    rule_state(app, rule, "running", Some(mount), None, true);
}
fn connection_state(
    app: &AppHandle,
    group: &Group,
    phase: &str,
    connection: Option<Arc<Connection>>,
    error: Option<&AppError>,
) {
    let status = ConnectionStatus {
        group_id: group.id.clone(),
        host_id: group.host_id.clone(),
        phase: phase.into(),
        session_id: connection.as_ref().map(|c| c.info.id.clone()),
        connected_at: connection.as_ref().map(|c| c.info.connected_at),
        retry_at: None,
        error: error.map(super::operations::error_value),
    };
    let old = app
        .state::<AppState>()
        .mount_runtime
        .lock()
        .connections
        .insert(group.id.clone(), (status, connection));
    drop(old); // Disconnect outside the book lock.
    changed(app);
}
pub(crate) async fn connect(
    app: &AppHandle,
    group: &Entry<Group>,
    authority: &Authority,
) -> AppResult<ConnectionStatus> {
    let state = app.state::<AppState>();
    authority.check(app)?;
    let handle = app.clone();
    let host_id = group.value.host_id.clone();
    let pin = state
        .mount_runtime
        .lock()
        .pins
        .get(&group.value.id)
        .cloned();
    let result = async {
        let target = if let Some(pin) = pin {
            crate::ssh::session::review::Target::capture_background(app, &pin).await?
        } else {
            crate::services::credentials::inspect(move || {
                let host = crate::services::hosts::resolve(&handle, &host_id)?;
                crate::ssh::session::review::Target::from_displayed(&handle, &host)
            })
            .await?
        };
        authority.check(app)?;
        state
            .mount_runtime
            .lock()
            .pins
            .insert(group.value.id.clone(), target.review());
        let existing = state
            .mount_runtime
            .lock()
            .connections
            .get(&group.value.id)
            .filter(|(_, c)| c.as_ref().is_some_and(|c| state.ssh.is_active(&c.info.id)))
            .and_then(|(_, c)| c.clone());
        if let Some(existing) = existing {
            target.verify_background(app).await?;
            authority.commit(app, || {
                target.with_current(app, |conn| {
                    if repository::get::<Group>(conn, &group.value.id)?
                        .is_none_or(|g| g.revision != group.revision)
                        || !state.ssh.is_active(&existing.info.id)
                    {
                        return Err(repository::changed());
                    }
                    connection_state(app, &group.value, "connected", Some(existing), None);
                    Ok(())
                })
            })?;
            return Ok(());
        }
        connection_state(app, &group.value, "connecting", None, None);
        let info = tokio::time::timeout(
            Duration::from_secs(90),
            target.connect(
                app.clone(),
                SshConnectRequest {
                    host_id: group.value.host_id.clone(),
                    background: true,
                    purpose: Some("mounts".into()),
                    password: None,
                    passphrase: None,
                    jump_credentials: HashMap::new(),
                    cols: 80,
                    rows: 24,
                },
                false,
                false,
            ),
        )
        .await
        .map_err(|_| AppError::Ssh("ssh.timeout".into()))??;
        let connection = Arc::new(Connection {
            app: app.clone(),
            info,
        });
        authority.commit(app, || {
            target.with_current(app, |conn| {
                let saved = repository::get::<Group>(conn, &group.value.id)?
                    .ok_or_else(repository::changed)?;
                if saved.revision != group.revision {
                    return Err(repository::changed());
                }
                state.ssh.publish(&connection.info.id)?;
                connection_state(
                    app,
                    &group.value,
                    "connected",
                    Some(connection.clone()),
                    None,
                );
                Ok(())
            })
        })?;
        Ok(())
    }
    .await;
    if let Err(error) = result {
        let old = state
            .mount_runtime
            .lock()
            .connections
            .get(&group.value.id)
            .and_then(|(_, c)| c.clone());
        connection_state(
            app,
            &group.value,
            if group.value.auto_reconnect && recovery::retryable(&error) {
                "retrying"
            } else {
                "needsAttention"
            },
            old,
            Some(&error),
        );
        return Err(error);
    }
    let status = state
        .mount_runtime
        .lock()
        .connections
        .get(&group.value.id)
        .unwrap()
        .0
        .clone();
    Ok(status)
}
pub(crate) async fn start(
    app: &AppHandle,
    rule: &Entry<Rule>,
    authority: &Authority,
) -> AppResult<RuleStatus> {
    let state = app.state::<AppState>();
    authority.check(app)?;
    let prior = state
        .mount_runtime
        .lock()
        .rules
        .get(&rule.value.id)
        .cloned();
    if let Some(status) = prior.filter(|s| s.revision == rule.revision && s.phase == "running") {
        if let (Some(id), Some(session)) = (&status.runtime_id, &status.session_id) {
            if state.ssh.is_active(session)
                && state
                    .mounts
                    .live_owned_mount(OWNER, 0, id, session)
                    .await
                    .is_ok()
            {
                return Ok(status);
            }
        }
    }
    let group = state
        .db
        .with(|conn| repository::get::<Group>(conn, &rule.value.group_id))?
        .ok_or_else(repository::changed)?;
    // Old failed FUSE records reserve their mount point until cleanup succeeds.
    stop(app, &rule.value.id, None, authority).await?;
    rule_state(app, rule, "starting", None, None, true);
    let connected = connect(app, &group, authority).await;
    let session = match connected {
        Ok(status) => status
            .session_id
            .ok_or_else(|| AppError::validation("ssh.sessionMissing"))?,
        Err(error) => {
            rule_state(app, rule, "failed", None, Some(&error), true);
            return Err(error);
        }
    };
    let before: std::collections::HashSet<_> = state
        .mounts
        .list(Some(OWNER))
        .await
        .into_iter()
        .map(|m| m.id)
        .collect();
    let result = state
        .mounts
        .mount(
            &state.ssh,
            OWNER,
            0,
            crate::mounts::MountRequest {
                session_id: session.clone(),
                remote_path: rule.value.remote_path.clone(),
                mount_point: rule.value.mount_point.clone(),
                read_only: rule.value.read_only,
            },
        )
        .await;
    match result {
        Ok(mount) => {
            let pin = state
                .mount_runtime
                .lock()
                .pins
                .get(&group.value.id)
                .cloned();
            let reviewed = async {
                let pin = pin.ok_or_else(repository::changed)?;
                crate::ssh::session::review::Target::capture_background(app, &pin).await
            }
            .await;
            let admission = reviewed.and_then(|target| {
                authority.commit(app, || {
                    target.with_current(app, |conn| {
                        if !state.ssh.is_active(&session) {
                            return Err(AppError::validation("mounts.transportClosed"));
                        }
                        if repository::get::<Rule>(conn, &rule.value.id)?
                            .is_none_or(|saved| saved.revision != rule.revision)
                        {
                            return Err(repository::changed());
                        }
                        rule_state(app, rule, "running", Some(&mount), None, true);
                        Ok(())
                    })
                })
            });
            if let Err(error) = admission {
                let cleanup = state.mounts.unmount(OWNER, &mount.id, false).await;
                rule_state(
                    app,
                    rule,
                    "failed",
                    cleanup.as_ref().err().map(|_| &mount),
                    Some(&error),
                    false,
                );
                return Err(error);
            }
        }
        Err(error) => {
            // Failed FUSE setup can retain a cleanup reservation. Keep its identity.
            let residue = state.mounts.list(Some(OWNER)).await.into_iter().find(|m| {
                !before.contains(&m.id)
                    && m.session_id == session
                    && m.remote_path == rule.value.remote_path
            });
            rule_state(
                app,
                rule,
                if recovery::retryable(&error) {
                    "failed"
                } else {
                    "needsAttention"
                },
                residue.as_ref(),
                Some(&error),
                true,
            );
            return Err(error);
        }
    }
    let status = state
        .mount_runtime
        .lock()
        .rules
        .get(&rule.value.id)
        .unwrap()
        .clone();
    Ok(status)
}
pub(crate) async fn stop(
    app: &AppHandle,
    id: &str,
    runtime_id: Option<&str>,
    authority: &Authority,
) -> AppResult<()> {
    authority.check(app)?;
    let state = app.state::<AppState>();
    let prior = state.mount_runtime.lock().rules.get(id).cloned();
    if let Some(mut prior) = prior {
        if runtime_id.is_some_and(|id| prior.runtime_id.as_deref() != Some(id)) {
            return Err(repository::changed());
        }
        prior.desired = false;
        state
            .mount_runtime
            .lock()
            .rules
            .insert(id.into(), prior.clone());
        if let Some(mount) = &prior.runtime_id {
            if state
                .mounts
                .list(Some(OWNER))
                .await
                .iter()
                .any(|m| m.id == *mount)
            {
                if let Err(error) = state
                    .mounts
                    .unmount_checked(OWNER, mount, false, Some(0), || authority.check(app))
                    .await
                {
                    prior.phase = "cleanupRequired".into();
                    prior.error = Some(super::operations::error_value(&error));
                    state.mount_runtime.lock().rules.insert(id.into(), prior);
                    changed(app);
                    return Err(error);
                }
            }
        }
        prior.phase = "stopped".into();
        prior.runtime_id = None;
        prior.session_id = None;
        prior.error = None;
        state.mount_runtime.lock().rules.insert(id.into(), prior);
        changed(app);
    } else if runtime_id.is_some() {
        return Err(repository::changed());
    }
    Ok(())
}
/// A user closing a published mount transport must stop the owning group first,
/// not simulate an outage that the recovery supervisor would immediately heal.
pub(crate) async fn disconnect_session(app: &AppHandle, session: &str) -> AppResult<()> {
    let state = app.state::<AppState>();
    let Some(group_id) = state.mount_runtime.group_for_session(session) else {
        return Ok(());
    };
    let _gate = state.mount_runtime.gate(&group_id)?;
    // The group may have reconnected before we acquired its gate. Never close
    // the replacement connection when the user selected an older session.
    if state.mount_runtime.group_for_session(session).as_deref() != Some(&group_id) {
        return Ok(());
    }
    let group = state
        .db
        .with(|conn| repository::get::<Group>(conn, &group_id))?
        .ok_or_else(repository::changed)?;
    disconnect(app, &group, &Authority(None)).await
}

pub(crate) async fn disconnect(
    app: &AppHandle,
    group: &Entry<Group>,
    authority: &Authority,
) -> AppResult<()> {
    authority.check(app)?;
    let ids: Vec<_> = app
        .state::<AppState>()
        .mount_runtime
        .rule_states()
        .into_iter()
        .filter(|s| s.group_id == group.value.id)
        .map(|s| s.rule_id)
        .collect();
    let mut first = None;
    for id in ids {
        if let Err(error) = stop(app, &id, None, authority).await {
            first.get_or_insert(error);
        }
    }
    if let Some(error) = first {
        return Err(error);
    }
    authority.commit(app, || {
        app.state::<AppState>()
            .mount_runtime
            .lock()
            .pins
            .remove(&group.value.id);
        connection_state(app, &group.value, "disconnected", None, None);
        Ok(())
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn session_close_targets_only_the_current_owning_mount_group() {
        let runtime = Coordinator::default();
        runtime.lock().connections.insert(
            "group".into(),
            (
                ConnectionStatus {
                    group_id: "group".into(),
                    session_id: Some("old".into()),
                    ..Default::default()
                },
                None,
            ),
        );
        assert_eq!(runtime.group_for_session("old").as_deref(), Some("group"));
        assert!(runtime.group_for_session("other").is_none());
        runtime
            .lock()
            .connections
            .get_mut("group")
            .unwrap()
            .0
            .session_id = Some("new".into());
        assert!(runtime.group_for_session("old").is_none());
        assert_eq!(runtime.group_for_session("new").as_deref(), Some("group"));
    }
    #[test]
    fn cleanup_reservations_block_edits_and_dropping_groups_releases_history() {
        let runtime = Coordinator::default();
        runtime.lock().rules.insert(
            "r".into(),
            RuleStatus {
                rule_id: "r".into(),
                group_id: "g".into(),
                phase: "cleanupRequired".into(),
                runtime_id: Some("old".into()),
                desired: false,
                ..Default::default()
            },
        );
        assert!(runtime.inactive("r").is_err());
        assert!(runtime.group_inactive("g").is_err());
        runtime.forget_group("g");
        assert!(runtime.inactive("r").is_ok());
        assert!(runtime.group_inactive("g").is_ok());
        assert!(runtime.rule_states().is_empty());
    }
    #[test]
    fn gates_remain_exclusive_until_the_owner_drops_and_revisions_have_boot_identity() {
        let runtime = Coordinator::default();
        assert_ne!(runtime.revision(), Coordinator::default().revision());
        let guard = runtime.gate("g").unwrap();
        assert!(runtime.gate("g").is_err());
        assert!(runtime.gate("other").is_ok());
        drop(guard);
        assert!(runtime.gate("g").is_ok());
    }
}
