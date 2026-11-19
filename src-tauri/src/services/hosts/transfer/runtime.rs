//! Bounded native import contexts. Secret payloads are never round-tripped through JS.
use super::*;
use crate::services::credentials::transfer::Write;
use std::{
    sync::Mutex,
    time::{Duration, Instant},
};

pub(super) struct Entry {
    pub envelope: Option<crypto::Envelope>,
    pub payload: Option<portable::Portable>,
    pub pending: Vec<Write>,
    pub result: Option<files::ImportResult>,
    touched: Instant,
}
impl Entry {
    pub fn new(envelope: Option<crypto::Envelope>, payload: Option<portable::Portable>) -> Self {
        Self {
            envelope,
            payload,
            pending: vec![],
            result: None,
            touched: Instant::now(),
        }
    }
}
#[derive(Default)]
pub(crate) struct Runtime(Mutex<HashMap<String, Entry>>);
impl Runtime {
    pub(super) fn insert(&self, entry: Entry) -> AppResult<String> {
        let mut entries = self.0.lock().map_err(|_| invalid())?;
        entries.retain(|_, e| e.touched.elapsed() < Duration::from_secs(600));
        if entries.len() >= 2 {
            return Err(AppError::validation("hostTransfer.busy"));
        }
        let id = uuid::Uuid::new_v4().to_string();
        entries.insert(id.clone(), entry);
        Ok(id)
    }
    pub(super) fn with<T>(
        &self,
        id: &str,
        operation: impl FnOnce(&mut Entry) -> AppResult<T>,
    ) -> AppResult<T> {
        let mut entries = self.0.lock().map_err(|_| invalid())?;
        entries.retain(|_, e| e.touched.elapsed() < Duration::from_secs(600));
        let entry = entries
            .get_mut(id)
            .ok_or_else(|| AppError::validation("hostTransfer.expired"))?;
        entry.touched = Instant::now();
        let result = operation(entry);
        entry.touched = Instant::now();
        result
    }
    pub(super) fn remove(&self, id: &str) {
        if let Ok(mut entries) = self.0.lock() {
            entries.remove(id);
        }
    }
    pub(super) fn prune(&self, id: &str) -> bool {
        if let Ok(mut entries) = self.0.lock() {
            entries.retain(|_, e| e.touched.elapsed() < Duration::from_secs(600));
            return entries.contains_key(id);
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounded_contexts_expire_and_release_invalidates_handles() {
        let runtime = Runtime::default();
        let a = runtime.insert(Entry::new(None, None)).unwrap();
        let b = runtime.insert(Entry::new(None, None)).unwrap();
        assert!(runtime.insert(Entry::new(None, None)).is_err());
        runtime
            .with(&a, |e| {
                e.touched = Instant::now() - Duration::from_secs(601);
                Ok(())
            })
            .unwrap();
        assert!(!runtime.prune(&a));
        assert!(runtime.with(&a, |_| Ok(())).is_err());
        let c = runtime.insert(Entry::new(None, None)).unwrap();
        runtime.remove(&b);
        runtime.remove(&c);
        assert!(runtime.with(&b, |_| Ok(())).is_err());
    }
}
