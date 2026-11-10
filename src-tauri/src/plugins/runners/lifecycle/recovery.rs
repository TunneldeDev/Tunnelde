//! Coalesced application-owned cleanup. Only persisted stop intents are retried;
//! reconnect never starts a runner or replays a prompt.
use super::super::{operations, repository, HostContext};
use crate::state::AppState;
use futures_util::{stream, StreamExt};
use std::time::Duration;
use tauri::Manager;

pub(in crate::plugins::runners) fn request_recovery(app: &tauri::AppHandle) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let mut recovery = state
        .runners
        .recovery
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    recovery.requested = true;
    if recovery.running {
        state.runners.recovery_signal.notify_one();
        return;
    }
    recovery.running = true;
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        worker(app).await;
    });
}

pub async fn on_reconnect(app: &tauri::AppHandle) {
    request_recovery(app);
}

async fn worker(app: tauri::AppHandle) {
    let mut delay = 1;
    let mut round = 0usize;
    loop {
        {
            let state = app.state::<AppState>();
            state
                .runners
                .recovery
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .requested = false;
        }
        let pending = pass(&app, round).await;
        round = round.wrapping_add(1);
        {
            let state = app.state::<AppState>();
            let mut recovery = state
                .runners
                .recovery
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            if !pending && !recovery.requested {
                recovery.running = false;
                return;
            }
        }
        let state = app.state::<AppState>();
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_secs(delay)) => {},
            _ = state.runners.recovery_signal.notified() => { delay = 1; },
        }
        delay = (delay * 2).min(30);
    }
}

async fn pass(app: &tauri::AppHandle, round: usize) -> bool {
    let state = app.state::<AppState>();
    let directory = state
        .storage
        .dir(crate::storage::layout::Category::Runners)
        .to_owned();
    let sessions = state.ssh.list();
    if sessions.is_empty() {
        return false;
    }
    let Ok(entries) = std::fs::read_dir(directory) else {
        return false;
    };
    let mut pending = false;
    // Bound each scan batch and yield even for directories full of unrelated files.
    let mut entries = entries;
    loop {
        let batch: Vec<_> = entries.by_ref().take(64).collect();
        if batch.is_empty() {
            break;
        }
        let mut jobs = Vec::new();
        for entry in batch.into_iter().flatten() {
            let path = entry.path();
            if path.extension().is_none_or(|extension| extension != "json") {
                continue;
            }
            let Some(id) = path.file_stem().and_then(|value| value.to_str()) else {
                continue;
            };
            if !crate::plugins::manifest::valid_id(id) {
                continue;
            }
            let context = HostContext {
                app: app.clone(),
                id: id.into(),
                fingerprint: String::new(),
                permissions: vec![],
                generation: 0,
                tool_client: None,
                tool_request: None,
            };
            let records = match repository::read(&context) {
                Ok(records) => records,
                Err(error) => {
                    tracing::warn!(plugin_id = %id, %error, "could not read runner recovery records");
                    continue;
                }
            };
            let mut selected: Vec<_> = records
                .into_iter()
                .filter(|record| record.stop_pending && record.runner_id != "deployment")
                .filter_map(|record| {
                    sessions
                        .iter()
                        .find(|session| {
                            state.ssh.identity(&session.id).is_ok_and(|identity| {
                                super::super::identity::verify(&record.deployment, &identity)
                                    .is_ok()
                            })
                        })
                        .map(|session| (record, session.id.clone()))
                })
                .collect();
            pending |= !selected.is_empty();
            if !selected.is_empty() {
                let length = selected.len();
                selected.rotate_left(round.wrapping_mul(2) % length);
                jobs.extend(
                    selected
                        .into_iter()
                        .take(8)
                        .map(|(record, session)| (context.clone(), record, session)),
                );
            }
        }
        stream::iter(jobs)
            .for_each_concurrent(8, |(context, record, session)| async move {
                let state = context.app.state::<AppState>();
                let Ok(_lease) = state.runners.admit_cleanup(&context.id, &record.runner_id) else {
                    return;
                };
                // The scan may be stale after another short metadata transaction.
                let Ok(current) = repository::read(&context) else {
                    return;
                };
                if !current
                    .iter()
                    .any(|item| item.stop_pending && item.same_revision(&record))
                {
                    return;
                }
            if let Err(error) = operations::stop_record(&context, &session, &record).await {
                tracing::debug!(plugin_id = %context.id, runner_id = %record.runner_id, error_code = error.code(),
                    "runner stop remains pending; retrying with backoff");
                }
            })
            .await;
        tokio::task::yield_now().await;
    }
    pending
}
