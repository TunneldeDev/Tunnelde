//! Transport-owned request lifetimes. Cancellation drops async work; it does not
//! roll back effects or forcibly stop an already running blocking operation.
use crate::error::{AppError, AppResult};
use std::{
    collections::HashMap,
    future::Future,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::watch;

const LIFETIME: Duration = Duration::from_secs(120);
type Key = (String, String);
struct Entry {
    signal: watch::Sender<bool>,
    deadline: Instant,
    claimed: bool,
}
#[derive(Clone, Default)]
pub(in crate::plugins) struct Requests {
    inner: Arc<Mutex<HashMap<Key, Arc<Mutex<Entry>>>>>,
}
pub(in crate::plugins) struct Request {
    requests: Requests,
    key: Key,
    entry: Arc<Mutex<Entry>>,
    cancelled: watch::Receiver<bool>,
    deadline: Instant,
}
fn expired() -> AppError {
    AppError::validation("plugin.api.requestExpired")
}
impl Requests {
    pub fn reserve(&self, owner: &str, id: &str) -> AppResult<()> {
        if owner.is_empty() || id.is_empty() || id.len() > 256 {
            return Err(AppError::validation("plugin.api.invalidRequest"));
        }
        let mut entries = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let now = Instant::now();
        entries.retain(|_, entry| {
            let entry = entry.lock().unwrap_or_else(|e| e.into_inner());
            // Active IDs remain reserved until their original reply finishes.
            // Otherwise a late cancellation response could answer a reused ID.
            entry.claimed || entry.deadline > now
        });
        let key = (owner.into(), id.into());
        if entries.contains_key(&key) {
            return Err(AppError::validation("plugin.api.duplicateRequest"));
        }
        if entries.len() >= 64 || entries.keys().filter(|(key, _)| key == owner).count() >= 32 {
            return Err(AppError::validation("plugin.api.busy"));
        }
        entries.insert(
            key,
            Arc::new(Mutex::new(Entry {
                signal: watch::channel(false).0,
                deadline: now + LIFETIME,
                claimed: false,
            })),
        );
        Ok(())
    }
    pub fn claim(&self, owner: &str, id: &str) -> AppResult<Request> {
        let key = (owner.into(), id.into());
        let entries = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let entry = entries.get(&key).cloned().ok_or_else(expired)?;
        let (cancelled, deadline) = {
            let mut state = entry.lock().unwrap_or_else(|e| e.into_inner());
            if state.deadline <= Instant::now() || *state.signal.borrow() {
                return Err(expired());
            }
            if state.claimed {
                return Err(AppError::validation("plugin.api.duplicateRequest"));
            }
            state.claimed = true;
            (state.signal.subscribe(), state.deadline)
        };
        Ok(Request {
            requests: self.clone(),
            key,
            entry,
            cancelled,
            deadline,
        })
    }
    pub fn cancel(&self, owner: &str, id: &str) -> bool {
        let mut entries = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let key = (owner.into(), id.into());
        if let Some(entry) = entries.get(&key).cloned() {
            let state = entry.lock().unwrap_or_else(|e| e.into_inner());
            state.signal.send_replace(true);
            if !state.claimed {
                entries.remove(&key);
            }
            true
        } else {
            false
        }
    }
    pub fn retire(&self, owner: &str) {
        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|(key, _), entry| {
                if key == owner {
                    entry
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .signal
                        .send_replace(true);
                    false
                } else {
                    true
                }
            });
    }
}
impl Request {
    pub async fn run<T>(&mut self, work: impl Future<Output = AppResult<T>>) -> AppResult<T> {
        tokio::select! {
            biased;
            _=self.cancelled.wait_for(|value|*value)=>Err(AppError::validation("plugin.api.cancelled")),
            _=tokio::time::sleep_until(self.deadline.into())=>Err(AppError::validation("plugin.timeout")),
            result=work=>result,
        }
    }
}
impl Drop for Request {
    fn drop(&mut self) {
        let mut entries = self
            .requests
            .inner
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if entries
            .get(&self.key)
            .is_some_and(|entry| Arc::ptr_eq(entry, &self.entry))
        {
            entries.remove(&self.key);
        }
    }
}

#[cfg(test)]
mod tests;
