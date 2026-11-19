//! Application-owned opt-in startup/recovery. UI visibility does not own these jobs.
mod book;
pub(crate) mod settings;
mod transport;

use super::contract::{ForwardRule, RevisionedInfo, RevisionedRule};
use crate::{
    error::{AppError, AppResult},
    state::AppState,
};
use book::{Book, Snapshot, Ticket};
use serde::{Deserialize, Serialize};
use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{Notify, Semaphore};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Options {
    #[serde(default)]
    pub auto_start: bool,
    #[serde(default)]
    pub auto_retry: bool,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub phase: &'static str,
    pub retry_at: Option<i64>,
    pub error: Option<serde_json::Value>,
}
impl Default for Status {
    fn default() -> Self {
        Self {
            phase: "idle",
            retry_at: None,
            error: None,
        }
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfiguredInfo {
    #[serde(flatten)]
    info: RevisionedInfo,
    automation: Options,
    automation_status: Status,
}
#[derive(Serialize)]
pub struct ConfiguredRule {
    #[serde(flatten)]
    pub entry: RevisionedRule,
    pub automation: Options,
}
#[derive(Default)]
pub(crate) struct Coordinator {
    book: Mutex<Book>,
    wake: Notify,
    pub(in crate::services::forwarding) connections: super::connections::Pool,
}
impl Coordinator {
    fn lock(&self) -> std::sync::MutexGuard<'_, Book> {
        self.book.lock().unwrap_or_else(|error| error.into_inner())
    }
}
pub(crate) fn changed(app: &AppHandle) {
    let _ = app.emit(
        "plugin://domain-changed",
        serde_json::json!({"domain":"forwards"}),
    );
    wake(app);
}
pub(crate) fn wake(app: &AppHandle) {
    if let Some(state) = app.try_state::<AppState>() {
        state.forward_automation.wake.notify_one();
    }
}
pub(crate) fn list(app: &AppHandle) -> AppResult<Vec<ConfiguredInfo>> {
    let state = app.state::<AppState>();
    let book = state.forward_automation.lock();
    let entries = super::list_revisioned(app)?;
    state.db.with(|conn| {
        entries
            .into_iter()
            .map(|info| {
                let automation = settings::read(conn, &info.info.rule.id, &info.revision)?;
                let automation_status = book.status(&info.info.rule.id, &info.revision);
                Ok(ConfiguredInfo {
                    info,
                    automation,
                    automation_status,
                })
            })
            .collect()
    })
}
pub(crate) fn save(
    app: &AppHandle,
    rule: ForwardRule,
    expected: Option<&str>,
    options: Options,
) -> AppResult<ConfiguredRule> {
    let entry = super::save_configured(app, rule, expected, options)?;
    Ok(ConfiguredRule {
        entry,
        automation: options,
    })
}
fn snapshots(app: &AppHandle) -> AppResult<Vec<Snapshot>> {
    let state = app.state::<AppState>();
    state.forwards.inspect_automation(|runtime| {
        state.db.with(|conn| {
            // Registry -> DB, matching normal listener admission and rule edits.
            let entries = super::repository::list_conn(conn)?;
            entries
                .into_iter()
                .map(|entry| {
                    let id = entry.rule.id;
                    let runtime = runtime(&id)?;
                    Ok(Snapshot {
                        options: settings::read(conn, &id, &entry.revision)?,
                        id,
                        revision: entry.revision,
                        session: runtime.session,
                        plugin_owned: runtime.plugin_owned,
                        stop_revision: runtime.stop_revision,
                    })
                })
                .collect()
        })
    })
}
fn snapshot(app: &AppHandle, id: &str) -> AppResult<Snapshot> {
    snapshots(app)?
        .into_iter()
        .find(|row| row.id == id)
        .ok_or_else(|| AppError::validation("forward.missing"))
}

/// Main-owned manual starts fence older automatic preparations immediately.
pub(crate) struct Attempt {
    app: AppHandle,
    ticket: Ticket,
    finished: bool,
}
impl Attempt {
    pub(crate) fn begin(app: &AppHandle, id: &str, expected: Option<&str>) -> AppResult<Self> {
        let state = app.state::<AppState>();
        let mut book = state.forward_automation.lock();
        let row = snapshot(app, id)?;
        if expected.is_some_and(|revision| revision != row.revision) {
            return Err(AppError::validation("forward.changed"));
        }
        let ticket = book.manual(&row);
        drop(book);
        changed(app);
        Ok(Self {
            app: app.clone(),
            ticket,
            finished: false,
        })
    }
    pub(crate) async fn cancelled(&self) {
        let mut receiver = self.ticket.cancelled.clone();
        if !*receiver.borrow() {
            let _ = receiver.changed().await;
        }
    }
    pub(crate) fn revision(&self) -> &str {
        &self.ticket.revision
    }
    pub(crate) fn commit(&self, commit: impl FnOnce() -> AppResult<()>) -> AppResult<()> {
        let state = self.app.state::<AppState>();
        let book = state.forward_automation.lock();
        book.check(&self.ticket)?;
        commit()
    }
    pub(crate) fn finish(mut self, result: &AppResult<()>, session: &str) {
        self.app
            .state::<AppState>()
            .forward_automation
            .lock()
            .finish(&self.ticket, result, Some(session.into()), Instant::now());
        self.finished = true;
        changed(&self.app);
    }
}
impl Drop for Attempt {
    fn drop(&mut self) {
        if !self.finished {
            let state = self.app.state::<AppState>();
            let mut book = state.forward_automation.lock();
            if book.check(&self.ticket).is_ok() {
                book.pause(&self.ticket.id);
            }
            drop(book);
            changed(&self.app);
        }
    }
}
pub(crate) fn pause(app: &AppHandle, id: &str) {
    app.state::<AppState>().forward_automation.lock().pause(id);
    changed(app);
}
pub(crate) fn pause_session(app: &AppHandle, session: &str) {
    let state = app.state::<AppState>();
    let mut book = state.forward_automation.lock();
    book.pause_session(session);
    if let Ok(rows) = snapshots(app) {
        for row in rows
            .into_iter()
            .filter(|row| row.session.as_deref() == Some(session))
        {
            book.pause(&row.id);
        }
    }
    drop(book);
    changed(app);
}
pub(crate) fn started(app: &AppHandle, id: &str, session: &str) {
    let state = app.state::<AppState>();
    let mut book = state.forward_automation.lock();
    if let Ok(row) = snapshot(app, id) {
        if row.session.as_deref() == Some(session) && !row.plugin_owned {
            let ticket = book.manual(&row);
            book.finish(&ticket, &Ok(()), Some(session.into()), Instant::now());
        }
    }
    drop(book);
    changed(app);
}

fn poll(app: &AppHandle, capacity: usize) -> AppResult<Vec<Ticket>> {
    let state = app.state::<AppState>();
    let mut book = state.forward_automation.lock();
    let rows = snapshots(app)?;
    let before: Vec<_> = rows
        .iter()
        .map(|row| book.status(&row.id, &row.revision))
        .collect();
    let jobs = book.poll(&rows, capacity, Instant::now());
    let updated = rows
        .iter()
        .zip(before)
        .any(|(row, before)| book.status(&row.id, &row.revision) != before);
    drop(book);
    if updated {
        changed(app);
    }
    Ok(jobs)
}
pub(crate) fn start(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let slots = Arc::new(Semaphore::new(4));
        loop {
            let handle = app.clone();
            let capacity = slots.available_permits();
            let jobs = tauri::async_runtime::spawn_blocking(move || poll(&handle, capacity)).await;
            match jobs {
                Ok(Ok(jobs)) => {
                    for ticket in jobs {
                        let Ok(permit) = slots.clone().try_acquire_owned() else {
                            break;
                        };
                        let handle = app.clone();
                        tauri::async_runtime::spawn(async move {
                            let _permit = permit;
                            let mut cancelled = ticket.cancelled.clone();
                            let result = if *cancelled.borrow() {
                                Err(AppError::validation("forward.startCancelled"))
                            } else {
                                tokio::select! { biased;
                                    _ = cancelled.changed() => Err(AppError::validation("forward.startCancelled")),
                                    result = tokio::time::timeout(Duration::from_secs(90), transport::run(&handle, &ticket)) => result.unwrap_or_else(|_| Err(AppError::Ssh("ssh.timeout".into()))),
                                }
                            };
                            let session = result.as_ref().ok().cloned();
                            let outcome = result.map(|_| ());
                            handle.state::<AppState>().forward_automation.lock().finish(
                                &ticket,
                                &outcome,
                                session,
                                Instant::now(),
                            );
                            changed(&handle);
                        });
                    }
                }
                Ok(Err(error)) => tracing::warn!(%error, "Cannot reconcile automatic forwards"),
                Err(error) => tracing::warn!(%error, "Automatic forwarding worker stopped"),
            }
            let state = app.state::<AppState>();
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_secs(1)) => {},
                _ = state.forward_automation.wake.notified() => {},
            }
        }
    });
}
