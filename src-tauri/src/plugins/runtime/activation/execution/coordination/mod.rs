//! Bounded, temporary startup operations. Active runtimes and domain resources
//! remain owned by the security policy and their existing services.
mod entry;
mod worker;

use std::{
    collections::HashMap,
    future::Future,
    sync::{Arc, Mutex},
};
use tokio::sync::Semaphore;

use crate::{
    error::{AppError, AppResult},
    plugins::PluginInfo,
};
use entry::{Entry, Ticket};

const MAX_STARTS: usize = 64;
const MAX_WAITERS: usize = 256;
const MAX_WAITERS_PER_START: usize = 32;

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(in crate::plugins) struct Key {
    pub id: String,
    pub stamp: String,
    pub fingerprint: String,
}

pub(in crate::plugins) struct Coordinator {
    entries: Mutex<HashMap<Key, Arc<Entry>>>,
    waiters: Arc<Semaphore>,
}

impl Coordinator {
    pub(in crate::plugins) fn new() -> Arc<Self> {
        Arc::new(Self {
            entries: Mutex::new(HashMap::new()),
            waiters: Arc::new(Semaphore::new(MAX_WAITERS)),
        })
    }

    /// Only the creator's factory and settlement callback run. A rejected or
    /// coalesced caller cannot start another engine. No external work runs while
    /// the map is locked; cancelled entries retain capacity until settlement.
    pub(in crate::plugins) fn join<W, F, S, C>(
        self: &Arc<Self>,
        key: Key,
        work: W,
        settle: S,
    ) -> AppResult<Ticket>
    where
        W: FnOnce() -> F + Send + 'static,
        F: Future<Output = AppResult<PluginInfo>> + Send + 'static,
        S: FnOnce(bool) -> C + Send + 'static,
        C: Future<Output = AppResult<()>> + Send + 'static,
    {
        let permit = self
            .waiters
            .clone()
            .try_acquire_owned()
            .map_err(|_| AppError::validation("plugin.api.busy"))?;
        let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = entries.get(&key) {
            return entry.ticket(permit);
        }
        if entries.len() >= MAX_STARTS {
            return Err(AppError::validation("plugin.api.busy"));
        }
        let entry = Entry::new();
        let ticket = entry.ticket(permit)?;
        entries.insert(key.clone(), entry.clone());
        drop(entries);
        worker::spawn(self.clone(), key, entry, work, settle);
        Ok(ticket)
    }

    pub(in crate::plugins) fn cancel_all(&self) {
        for entry in self
            .entries
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
        {
            entry.cancel();
        }
    }
}

#[cfg(test)]
mod tests;
