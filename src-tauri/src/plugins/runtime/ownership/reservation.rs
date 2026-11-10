use super::registry::Registry;
use std::sync::Arc;

pub(in crate::plugins) struct Reservation<T> {
    pub(super) registry: Arc<Registry<T>>,
    pub(super) token: String,
    pub(super) committed: bool,
}

impl<T> Reservation<T> {
    /// Keep the value on failure so the adapter can dispose it outside the lock.
    pub fn commit(mut self, value: T) -> Result<(), T> {
        let mut entries = self
            .registry
            .entries
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let Some(entry) = entries.get_mut(&self.token) else {
            return Err(value);
        };
        entry.value = Some(value);
        self.committed = true;
        Ok(())
    }
}

impl<T> Drop for Reservation<T> {
    fn drop(&mut self) {
        if !self.committed {
            self.registry
                .entries
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&self.token);
        }
    }
}
