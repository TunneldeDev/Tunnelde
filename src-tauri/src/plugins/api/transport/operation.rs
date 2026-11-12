use crate::error::{AppError, AppResult};
use std::sync::{
    atomic::{AtomicU8, Ordering},
    Arc,
};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
pub(in crate::plugins::api) struct Operation(Ticket);
#[derive(Clone)]
pub(in crate::plugins::api) struct Ticket {
    state: Arc<AtomicU8>, // live=0, committing=1, cancelled=2
    _capacity: Arc<OwnedSemaphorePermit>,
}
impl Operation {
    pub fn admit(capacity: Arc<Semaphore>) -> AppResult<Self> {
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

    /// Call once, under the final authorization/CAS fences, immediately before
    /// durable publication. Later caller cancellation cannot undo that commit.
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
    #[test]
    fn cancelled_async_owner_keeps_worker_charged_until_it_exits() {
        let capacity = Arc::new(Semaphore::new(1));
        let owner = Operation::admit(capacity.clone()).unwrap();
        let worker = owner.ticket();
        drop(owner);
        assert_eq!(
            worker.check().unwrap_err().to_string(),
            "plugin.api.cancelled"
        );
        assert!(Operation::admit(capacity.clone()).is_err());
        drop(worker);
        assert!(Operation::admit(capacity).is_ok());
    }

    #[test]
    fn commit_has_one_winner_and_late_cancellation_cannot_undo_it() {
        let owner = Operation::admit(Arc::new(Semaphore::new(1))).unwrap();
        let ticket = owner.ticket();
        ticket.commit().unwrap();
        drop(owner);
        ticket.check().unwrap();
        assert!(ticket.commit().is_err());
        let owner = Operation::admit(Arc::new(Semaphore::new(1))).unwrap();
        let ticket = owner.ticket();
        drop(owner);
        assert!(ticket.commit().is_err());
    }

    #[test]
    fn concurrent_cancel_or_commit_never_publishes_after_cancellation_wins() {
        for _ in 0..128 {
            let capacity = Arc::new(Semaphore::new(1));
            let owner = Operation::admit(capacity.clone()).unwrap();
            let ticket = owner.ticket();
            let worker = ticket.clone();
            let barrier = Arc::new(std::sync::Barrier::new(2));
            let start = barrier.clone();
            let thread = std::thread::spawn(move || {
                start.wait();
                worker.commit().is_ok()
            });
            barrier.wait();
            drop(owner);
            let committed = thread.join().unwrap();
            assert_eq!(ticket.check().is_ok(), committed);
            assert!(Operation::admit(capacity.clone()).is_err());
            drop(ticket);
            assert!(Operation::admit(capacity).is_ok());
        }
    }
}
