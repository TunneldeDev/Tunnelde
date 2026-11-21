//! Deterministic per-rule intent, cancellation and bounded retry scheduling.
use super::{Options, Status};
use crate::error::{AppError, AppResult};
use std::{
    collections::{HashMap, HashSet},
    time::{Duration, Instant},
};
use tokio::sync::watch;

pub(super) struct Snapshot {
    pub id: String,
    pub revision: String,
    pub options: Options,
    pub session: Option<String>,
    pub plugin_owned: bool,
    pub stop_revision: (u64, u64),
}
pub(super) struct Ticket {
    pub id: String,
    pub revision: String,
    pub epoch: String,
    pub cancelled: watch::Receiver<bool>,
    pub stop_revision: (u64, u64),
}
struct Entry {
    revision: String,
    stop_revision: (u64, u64),
    options: Options,
    epoch: String,
    cancel: watch::Sender<bool>,
    wanted: bool,
    busy: bool,
    was_active: bool,
    session: Option<String>,
    failures: u32,
    due: Option<Instant>,
    status: Status,
}
impl Entry {
    fn new(row: &Snapshot, wanted: bool) -> Self {
        Self {
            revision: row.revision.clone(),
            stop_revision: row.stop_revision,
            options: row.options,
            epoch: uuid::Uuid::new_v4().to_string(),
            cancel: watch::channel(false).0,
            wanted,
            busy: false,
            was_active: false,
            session: row.session.clone(),
            failures: 0,
            due: None,
            status: Status::default(),
        }
    }
    fn cancel(&mut self) {
        self.cancel.send_replace(true);
        self.epoch = uuid::Uuid::new_v4().to_string();
        self.wanted = false;
        self.busy = false;
        self.due = None;
        self.status = Status {
            phase: "paused",
            ..Default::default()
        };
    }
    fn ticket(&mut self, id: &str) -> Ticket {
        self.cancel.send_replace(true);
        self.cancel = watch::channel(false).0;
        self.epoch = uuid::Uuid::new_v4().to_string();
        self.busy = true;
        self.status = Status {
            phase: "starting",
            ..Default::default()
        };
        Ticket {
            id: id.into(),
            revision: self.revision.clone(),
            epoch: self.epoch.clone(),
            cancelled: self.cancel.subscribe(),
            stop_revision: self.stop_revision,
        }
    }
}
#[derive(Default)]
pub(super) struct Book {
    entries: HashMap<String, Entry>,
    initialized: bool,
    paused: HashSet<String>,
}
impl Book {
    pub fn status(&self, id: &str, revision: &str) -> Status {
        self.entries
            .get(id)
            .filter(|e| e.revision == revision)
            .map(|e| e.status.clone())
            .unwrap_or_default()
    }
    pub fn poll(&mut self, rows: &[Snapshot], capacity: usize, now: Instant) -> Vec<Ticket> {
        self.entries.retain(|id, entry| {
            let keep = rows.iter().any(|row| {
                row.id == *id && row.revision == entry.revision && row.options == entry.options
            });
            if !keep {
                entry.cancel();
            }
            keep
        });
        self.paused
            .retain(|id| rows.iter().any(|row| row.id == *id));
        let mut jobs = Vec::new();
        for row in rows {
            let entry = self.entries.entry(row.id.clone()).or_insert_with(|| {
                Entry::new(
                    row,
                    !self.initialized
                        && row.options.auto_start
                        && !self.paused.contains(&row.id)
                        && row.stop_revision == (0, 0),
                )
            });
            if row.stop_revision != entry.stop_revision
                || row.plugin_owned
                || self.paused.contains(&row.id)
            {
                entry.cancel();
                entry.stop_revision = row.stop_revision;
            }
            if let Some(session) = &row.session {
                entry.session = Some(session.clone());
                entry.was_active = true;
                if !entry.busy && entry.status.phase != "paused" {
                    entry.failures = 0;
                    entry.due = None;
                    entry.status = Status {
                        phase: "running",
                        ..Default::default()
                    };
                }
                continue;
            }
            if entry.busy {
                continue;
            }
            if entry.was_active {
                entry.was_active = false;
                if entry.wanted && entry.options.auto_retry {
                    entry.due = Some(now + Duration::from_secs(2));
                    entry.status = Status {
                        phase: "retrying",
                        retry_at: Some(crate::models::now_ms() + 2000),
                        error: None,
                    };
                } else {
                    entry.wanted = false;
                    if entry.status.phase != "paused" {
                        entry.status = Status::default();
                    }
                }
            }
            if entry.wanted && entry.due.is_none_or(|due| due <= now) && jobs.len() < capacity {
                jobs.push(entry.ticket(&row.id));
            }
        }
        self.initialized = true;
        jobs
    }
    pub fn manual(&mut self, row: &Snapshot) -> Ticket {
        self.paused.remove(&row.id);
        if let Some(old) = self.entries.get_mut(&row.id) {
            old.cancel();
        }
        let mut entry = Entry::new(row, true);
        let ticket = entry.ticket(&row.id);
        self.entries.insert(row.id.clone(), entry);
        ticket
    }
    pub fn check(&self, ticket: &Ticket) -> AppResult<()> {
        if self.entries.get(&ticket.id).is_some_and(|entry| {
            entry.epoch == ticket.epoch && entry.revision == ticket.revision && entry.busy
        }) {
            Ok(())
        } else {
            Err(AppError::validation("forward.startCancelled"))
        }
    }
    pub fn finish(
        &mut self,
        ticket: &Ticket,
        result: &AppResult<()>,
        session: Option<String>,
        now: Instant,
    ) {
        if self.check(ticket).is_err() {
            return;
        }
        let entry = self.entries.get_mut(&ticket.id).unwrap();
        entry.busy = false;
        match result {
            Ok(()) => {
                entry.was_active = true;
                entry.session = session;
                entry.wanted = entry.options.auto_retry;
                entry.failures = 0;
                entry.due = None;
                entry.status = Status {
                    phase: "running",
                    ..Default::default()
                };
            }
            Err(error) => {
                entry.failures = entry.failures.saturating_add(1);
                let retry = entry.options.auto_retry && retryable(error);
                let delay = retry_delay(entry.failures);
                entry.wanted = retry;
                entry.due = retry.then_some(now + delay);
                entry.status = Status {
                    phase: if retry { "retrying" } else { "needsAttention" },
                    retry_at: retry.then(|| crate::models::now_ms() + delay.as_millis() as i64),
                    error: serde_json::to_value(error).ok(),
                };
            }
        }
    }
    pub fn pause(&mut self, id: &str) {
        self.paused.insert(id.into());
        if let Some(entry) = self.entries.get_mut(id) {
            entry.cancel();
        }
    }
    pub fn pause_session(&mut self, session: &str) {
        let ids: Vec<_> = self
            .entries
            .iter()
            .filter(|(_, entry)| entry.session.as_deref() == Some(session))
            .map(|(id, _)| id.clone())
            .collect();
        for id in ids {
            self.pause(&id);
        }
    }
}
fn retry_delay(failures: u32) -> Duration {
    Duration::from_secs((2_u64.saturating_pow(failures.min(6))).min(60))
}
fn retryable(error: &AppError) -> bool {
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
            "forward.bindFailed" | "forward.remoteRejected" | "ssh.sessionMissing"
        ),
        _ => false,
    }
}

#[cfg(test)]
mod tests;
