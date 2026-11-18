//! Recovery is owned by the host, independent of any contributing plugin view.
use super::*;
use std::time::Instant;
use tokio::sync::Semaphore;

pub(crate) fn retryable(error: &AppError) -> bool {
    match error.original() {
        AppError::Io(_) => true,
        AppError::Ssh(message) => ![
            "ssh.authFailed",
            "ssh.passwordRequired",
            "ssh.usernameRequired",
            "ssh.agentUnsupported",
            "ssh.keyPathRequired",
            "ssh.keyLoad",
            "ssh.hostKey",
            "ssh.connectionChanged",
            "network.invalid",
        ]
        .iter()
        .any(|key| message.starts_with(key)),
        AppError::Validation(message) => matches!(
            message.as_str(),
            "mounts.transportClosed" | "ssh.sessionMissing" | "mounts.pathTimeout"
        ),
        _ => false,
    }
}
fn delay(failures: u32) -> Duration {
    Duration::from_secs(2_u64.saturating_pow(failures.min(6)).min(60))
}
#[derive(Default)]
struct Retry {
    busy: bool,
    failures: u32,
    next: Option<Instant>,
}
type Retries = Arc<Mutex<HashMap<String, Retry>>>;

pub(crate) fn shutdown(state: &AppState) {
    let _admission = state
        .mount_runtime
        .admission
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    state
        .mount_runtime
        .shutting_down
        .store(true, std::sync::atomic::Ordering::Release);
    state.mount_runtime.operations.cancel_all();
    state.mount_runtime.changed.notify_waiters();
}
pub(crate) fn launch(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let slots = Arc::new(Semaphore::new(4));
        let retries: Retries = Default::default();
        let mut cursor = 0;
        loop {
            let state = app.state::<AppState>();
            if state
                .mount_runtime
                .shutting_down
                .load(std::sync::atomic::Ordering::Acquire)
            {
                break;
            }
            let handle = app.clone();
            let snapshot = tauri::async_runtime::spawn_blocking(move || {
                handle.state::<AppState>().db.with(|conn| {
                    Ok((
                        repository::all::<Group>(conn, None)?,
                        repository::all::<Rule>(conn, None)?,
                    ))
                })
            })
            .await;
            if let Ok(Ok((groups, rules))) = snapshot {
                let ids: std::collections::HashSet<_> =
                    groups.iter().map(|g| g.value.id.as_str()).collect();
                let stale: std::collections::HashSet<_> = state
                    .mount_runtime
                    .connection_states()
                    .into_iter()
                    .map(|s| s.group_id)
                    .chain(
                        state
                            .mount_runtime
                            .rule_states()
                            .into_iter()
                            .map(|s| s.group_id),
                    )
                    .filter(|id| !ids.contains(id.as_str()))
                    .collect();
                for stale_id in stale {
                    // Host deletion must release its dedicated transport and mount reservations.
                    if let Ok(_gate) = state.mount_runtime.gate(&stale_id) {
                        if !matches!(
                            state
                                .db
                                .with(|conn| repository::get::<Group>(conn, &stale_id)),
                            Ok(None)
                        ) {
                            continue;
                        }
                        for rule in state
                            .mount_runtime
                            .rule_states()
                            .into_iter()
                            .filter(|r| r.group_id == stale_id)
                        {
                            let _ = stop(&app, &rule.rule_id, None, &Authority(None)).await;
                        }
                        if !state
                            .mount_runtime
                            .rule_states()
                            .iter()
                            .any(|r| r.group_id == stale_id && r.runtime_id.is_some())
                        {
                            state.mount_runtime.forget_group(&stale_id);
                            changed(&app);
                        }
                    }
                }
                retries
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .retain(|id, r| ids.contains(id.as_str()) || r.busy);
                let count = groups.len();
                for (index, group) in groups.iter().enumerate().cycle().skip(cursor).take(count) {
                    let status = state
                        .mount_runtime
                        .connection_states()
                        .into_iter()
                        .find(|s| s.group_id == group.value.id);
                    // Automatic startup is explicit via connectAndStartAuto. Only a previously
                    // requested connection is recovered; saving/importing rules never connects.
                    if status.as_ref().is_none_or(|s| {
                        matches!(s.phase.as_str(), "disconnected" | "needsAttention")
                    }) {
                        continue;
                    }
                    let Ok(permit) = slots.clone().try_acquire_owned() else {
                        break;
                    };
                    cursor = (index + 1) % count;
                    {
                        let mut retries = retries.lock().unwrap_or_else(|e| e.into_inner());
                        let retry = retries.entry(group.value.id.clone()).or_default();
                        if retry.busy || retry.next.is_some_and(|at| at > Instant::now()) {
                            continue;
                        }
                        retry.busy = true;
                    }
                    let handle = app.clone();
                    let retries = retries.clone();
                    let group = group.clone();
                    let rules: Vec<_> = rules
                        .iter()
                        .filter(|r| r.value.group_id == group.value.id)
                        .cloned()
                        .collect();
                    tauri::async_runtime::spawn(async move {
                        let _permit = permit;
                        let state = handle.state::<AppState>();
                        let gate = state.mount_runtime.gate(&group.value.id).ok();
                        let outcome = if gate.is_some() {
                            reconcile(&handle, &group, &rules).await
                        } else {
                            Ok(())
                        };
                        let mut retries = retries.lock().unwrap_or_else(|e| e.into_inner());
                        let retry = retries.entry(group.value.id.clone()).or_default();
                        retry.busy = false;
                        match outcome {
                            Ok(()) => {
                                retry.failures = 0;
                                retry.next = None;
                            }
                            Err(error) => {
                                retry.failures = retry.failures.saturating_add(1);
                                let wait = delay(retry.failures);
                                retry.next = Some(Instant::now() + wait);
                                if let Some((status, _)) = state
                                    .mount_runtime
                                    .lock()
                                    .connections
                                    .get_mut(&group.value.id)
                                {
                                    status.phase =
                                        if retryable(&error) && group.value.auto_reconnect {
                                            "retrying"
                                        } else {
                                            "needsAttention"
                                        }
                                        .into();
                                    status.retry_at = (status.phase == "retrying")
                                        .then(|| crate::models::now_ms() + wait.as_millis() as i64);
                                    status.error =
                                        Some(super::super::operations::error_value(&error));
                                }
                                changed(&handle);
                            }
                        }
                    });
                }
            }
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_secs(2)) => {},
                _ = state.mount_runtime.changed.notified() => {},
            }
        }
    });
}
async fn reconcile(app: &AppHandle, group: &Entry<Group>, rules: &[Entry<Rule>]) -> AppResult<()> {
    let state = app.state::<AppState>();
    let authority = Authority(None);
    authority.check(app)?;
    // Re-read under the group gate: a manual disconnect may have won after scheduling.
    let paused = state
        .mount_runtime
        .lock()
        .connections
        .get(&group.value.id)
        .is_none_or(|(status, _)| {
            matches!(status.phase.as_str(), "disconnected" | "needsAttention")
        });
    if paused
        || state
            .db
            .with(|conn| repository::get::<Group>(conn, &group.value.id))?
            .is_none_or(|saved| saved.revision != group.revision)
    {
        return Ok(());
    }
    // The exact original route must remain valid even while the socket is alive.
    let pin = state
        .mount_runtime
        .lock()
        .pins
        .get(&group.value.id)
        .cloned();
    if let Some(pin) = pin {
        let target = crate::ssh::session::review::Target::capture_background(app, &pin).await?;
        target.verify_background(app).await?;
    }
    let connection = state
        .mount_runtime
        .connection_states()
        .into_iter()
        .find(|s| s.group_id == group.value.id);
    let active = connection
        .as_ref()
        .and_then(|s| s.session_id.as_ref())
        .is_some_and(|id| state.ssh.is_active(id));
    let mut restore = Vec::new();
    let statuses = state.mount_runtime.rule_states();
    for rule in rules {
        let Some(status) = statuses
            .iter()
            .find(|s| s.rule_id == rule.value.id && s.revision == rule.revision && s.desired)
        else {
            continue;
        };
        if status.phase == "needsAttention" {
            continue;
        }
        let healthy = if let (Some(id), Some(session)) = (&status.runtime_id, &status.session_id) {
            active
                && state
                    .mounts
                    .live_owned_mount(OWNER, 0, id, session)
                    .await
                    .is_ok()
        } else {
            false
        };
        if !healthy {
            if group.value.auto_reconnect {
                restore.push(rule);
            } else {
                let mut book = state.mount_runtime.lock();
                if let Some(s) = book.rules.get_mut(&rule.value.id) {
                    s.phase = "needsAttention".into();
                }
                drop(book);
                changed(app);
            }
        }
    }
    if active && restore.is_empty() {
        return Ok(());
    }
    if !group.value.auto_reconnect {
        return Err(AppError::validation("mounts.transportClosed"));
    }
    // Unmount all broken FUSE instances before discarding their SSH transport.
    let mut cleaned = Vec::new();
    for rule in restore {
        let result = stop(app, &rule.value.id, None, &authority).await;
        if let Some(s) = state.mount_runtime.lock().rules.get_mut(&rule.value.id) {
            s.desired = true;
            if result.is_err() {
                s.phase = "needsAttention".into();
            }
        }
        if result.is_ok() {
            cleaned.push(rule);
        } else {
            changed(app);
        }
    }
    connect(app, group, &authority).await?;
    let mut first = None;
    for rule in cleaned {
        if let Err(error) = start(app, rule, &authority).await {
            // A local dependency or path failure belongs to this rule. Keep
            // supervising other mounts on the still-healthy group connection.
            if retryable(&error) {
                first.get_or_insert(error);
            }
        }
    }
    first.map_or(Ok(()), Err)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn recovery_does_not_retry_authentication_trust_or_route_changes() {
        for key in [
            "ssh.authFailed",
            "ssh.hostKeyChanged",
            "ssh.connectionChanged",
            "ssh.keyLoad",
        ] {
            assert!(!retryable(&AppError::Ssh(key.into())));
        }
        assert!(retryable(&AppError::Ssh("ssh.timeout".into())));
        assert!(!retryable(&AppError::validation(
            "mounts.dependencies.required"
        )));
        assert_eq!(delay(1), Duration::from_secs(2));
        assert_eq!(delay(100), Duration::from_secs(60));
    }
}
