//! Dropping an async caller cannot stop a blocking worker. Retain its capacity
//! and linearize cancellation against publication, after the final CAS check.
use crate::error::{AppError, AppResult};
use std::sync::{
    atomic::{AtomicU8, Ordering},
    Arc, OnceLock,
};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

pub(super) struct Operation(Ticket);
#[derive(Clone)]
pub(super) struct Ticket {
    state: Arc<AtomicU8>, // live=0, committing=1, cancelled=2
    _capacity: Arc<OwnedSemaphorePermit>,
}
impl Operation {
    pub fn admit() -> AppResult<Self> {
        static CAPACITY: OnceLock<Arc<Semaphore>> = OnceLock::new();
        Self::with_capacity(CAPACITY.get_or_init(|| Arc::new(Semaphore::new(4))).clone())
    }
    fn with_capacity(capacity: Arc<Semaphore>) -> AppResult<Self> {
        Ok(Self(Ticket {
            state: Arc::new(AtomicU8::new(0)),
            _capacity: Arc::new(
                capacity
                    .try_acquire_owned()
                    .map_err(|_| AppError::validation("plugin.api.busy"))?,
            ),
        }))
    }
    pub fn ticket(&self) -> Ticket {
        self.0.clone()
    }
}
impl Drop for Operation {
    fn drop(&mut self) {
        let _ = self
            .0
            .state
            .compare_exchange(0, 2, Ordering::AcqRel, Ordering::Acquire);
    }
}
impl Ticket {
    pub fn check(&self) -> AppResult<()> {
        if self.state.load(Ordering::Acquire) == 2 {
            Err(AppError::validation("plugin.api.cancelled"))
        } else {
            Ok(())
        }
    }
    /// Only call while holding the live policy and metadata fences, immediately
    /// before publishing synced metadata. A late cancellation cannot undo this.
    pub fn commit(&self) -> AppResult<()> {
        self.state
            .compare_exchange(0, 1, Ordering::AcqRel, Ordering::Acquire)
            .map(|_| ())
            .map_err(|_| AppError::validation("plugin.api.cancelled"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn aborted_waiter_retains_worker_capacity_and_cannot_commit() {
        let capacity = Arc::new(Semaphore::new(1));
        let owner = Operation::with_capacity(capacity.clone()).unwrap();
        let ticket = owner.ticket();
        let (started, waiting) = tokio::sync::oneshot::channel();
        let (release, finish) = std::sync::mpsc::channel();
        let (sent, received) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            let _owner = owner;
            tokio::task::spawn_blocking(move || {
                started.send(()).unwrap();
                finish.recv().unwrap();
                sent.send(ticket.commit().map_err(|e| e.to_string()))
                    .unwrap();
            })
            .await
            .unwrap();
        });
        waiting.await.unwrap();
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        assert!(Operation::with_capacity(capacity.clone()).is_err());
        release.send(()).unwrap();
        assert_eq!(received.await.unwrap().unwrap_err(), "plugin.api.cancelled");
        let _settled = tokio::time::timeout(std::time::Duration::from_secs(2), capacity.acquire())
            .await
            .unwrap()
            .unwrap();
    }
    #[test]
    fn cancellation_after_commit_does_not_undo_publication() {
        let owner = Operation::with_capacity(Arc::new(Semaphore::new(1))).unwrap();
        let ticket = owner.ticket();
        ticket.commit().unwrap();
        drop(owner);
        ticket.check().unwrap();
        assert!(ticket.commit().is_err()); // no second publication
    }
}
