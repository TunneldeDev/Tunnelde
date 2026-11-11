//! A provider panel's unpublished work. Accepted resources belong to its runtime instead.
use super::super::security::Lease;
use crate::error::{AppError, AppResult};
use std::{
    collections::{HashMap, HashSet},
    future::Future,
    sync::{Arc, Mutex},
};
use tokio::sync::{watch, Semaphore};

pub(super) struct Scope {
    pub lease: Lease,
    pub token: String,
    pub host: String,
    pub view: String,
    pub selection_revision: u64,
    state: Mutex<Option<HashSet<String>>>,
    cancelled: watch::Sender<bool>,
    capacity: Arc<Semaphore>,
}
impl Scope {
    pub fn with_live<T>(
        &self,
        operation: impl FnOnce(&mut HashSet<String>) -> AppResult<T>,
    ) -> AppResult<T> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        operation(
            state
                .as_mut()
                .ok_or_else(|| AppError::validation("plugin.forwarding.expired"))?,
        )
    }
    pub async fn guard<T>(&self, operation: impl Future<Output = AppResult<T>>) -> AppResult<T> {
        let mut cancel = self.cancelled.subscribe();
        self.with_live(|_| Ok(()))?;
        let _permit = self
            .capacity
            .clone()
            .try_acquire_owned()
            .map_err(|_| AppError::validation("plugin.forwarding.busy"))?;
        tokio::select! {
            biased;
            _ = cancel.changed() => Err(AppError::validation("plugin.forwarding.expired")),
            result = operation => result,
        }
    }
    fn close(&self) -> Vec<String> {
        let owned = self.state.lock().unwrap_or_else(|e| e.into_inner()).take();
        self.cancelled.send_replace(true);
        owned.into_iter().flatten().collect()
    }
}

#[derive(Default)]
pub struct Registry(Mutex<HashMap<String, Arc<Scope>>>);
impl Registry {
    pub(super) fn open(
        &self,
        lease: Lease,
        token: String,
        host: String,
        view: String,
        selection_revision: u64,
    ) -> AppResult<String> {
        let mut scopes = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if scopes.len() >= 128 || scopes.values().filter(|s| s.lease.id == lease.id).count() >= 16 {
            return Err(AppError::validation("plugin.forwarding.busy"));
        }
        let id = uuid::Uuid::new_v4().to_string();
        scopes.insert(
            id.clone(),
            Arc::new(Scope {
                lease,
                token,
                host,
                view,
                selection_revision,
                state: Mutex::new(Some(HashSet::new())),
                cancelled: watch::channel(false).0,
                capacity: Arc::new(Semaphore::new(4)),
            }),
        );
        Ok(id)
    }
    pub(super) fn get(&self, id: &str, token: &str) -> AppResult<Arc<Scope>> {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(id)
            .filter(|scope| scope.token == token)
            .cloned()
            .ok_or_else(|| AppError::validation("plugin.forwarding.expired"))
    }
    pub(super) fn close(&self, id: &str, token: &str) -> Vec<String> {
        self.remove(|key, scope| key == id && scope.token == token)
    }
    pub(super) fn remove(&self, matches: impl Fn(&str, &Scope) -> bool) -> Vec<String> {
        let mut scopes = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let keys: Vec<_> = scopes
            .iter()
            .filter(|(id, scope)| matches(id, scope))
            .map(|(id, _)| id.clone())
            .collect();
        let retired: Vec<_> = keys
            .into_iter()
            .filter_map(|id| scopes.remove(&id))
            .collect();
        drop(scopes);
        retired.iter().flat_map(|scope| scope.close()).collect()
    }
}

#[cfg(test)]
mod tests;
