//! Pending browser acquisitions, never a second table of live SSH ownership.
use super::super::super::{coordinator::Lease, Record};
use crate::{
    error::{AppError, AppResult},
    ssh::{session::review::Review, SessionInfo},
};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};

#[derive(Default)]
pub(in crate::plugins::runners) struct Registry {
    pub(super) entries: Mutex<BTreeMap<String, Arc<Pending>>>,
}

pub(super) struct Pending {
    pub plugin_id: String,
    pub token: String,
    pub record: Record,
    pub cancelled: tokio::sync::watch::Sender<bool>,
    pub connection: Mutex<Connection>,
    pub _lease: Lease,
}

#[derive(Default)]
pub(super) struct Connection {
    pub review: Option<Review>,
    pub session: Option<SessionInfo>,
    pub acquired: bool,
    pub busy: bool,
}

impl Registry {
    pub(super) fn get(&self, id: &str) -> AppResult<Arc<Pending>> {
        self.entries
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(id)
            .cloned()
            .ok_or_else(|| AppError::validation("plugin.runners.browserExpired"))
    }

    pub(super) fn insert(&self, id: String, pending: Arc<Pending>) -> AppResult<()> {
        let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        if entries.len() >= 8 || entries.contains_key(&id) {
            return Err(AppError::validation("plugin.runners.busy"));
        }
        entries.insert(id, pending);
        Ok(())
    }

    pub(super) fn remove(&self, id: &str) -> Option<Arc<Pending>> {
        let pending = self
            .entries
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(id)?;
        pending.cancel();
        Some(pending)
    }

    pub(super) fn remove_matching(
        &self,
        id: &str,
        expected: &Arc<Pending>,
    ) -> Option<Arc<Pending>> {
        let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        if entries
            .get(id)
            .is_none_or(|pending| !Arc::ptr_eq(pending, expected))
        {
            return None;
        }
        let pending = entries.remove(id)?;
        pending.cancel();
        Some(pending)
    }
}

impl Pending {
    /// Serialize cancellation with synchronous trust and session acceptance.
    fn cancel(&self) {
        let _connection = self.connection.lock().unwrap_or_else(|e| e.into_inner());
        self.cancelled.send_replace(true);
    }
}

/// A disconnected page or abandoned verification drops all in-flight SSH work.
pub(super) async fn guard<T>(
    pending: &Pending,
    future: impl std::future::Future<Output = AppResult<T>>,
) -> AppResult<T> {
    let mut cancel = pending.cancelled.subscribe();
    if *cancel.borrow() {
        return Err(AppError::validation("plugin.runners.browserExpired"));
    }
    tokio::select! {
        biased;
        _ = cancel.changed() => Err(AppError::validation("plugin.runners.browserExpired")),
        result = future => result,
    }
}
