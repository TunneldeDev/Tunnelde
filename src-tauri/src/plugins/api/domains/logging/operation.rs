use crate::error::{AppError, AppResult};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
pub(super) struct Operation(Ticket);
#[derive(Clone)]
pub(super) struct Ticket {
    cancelled: Arc<AtomicBool>,
    _capacity: Arc<OwnedSemaphorePermit>,
}
impl Operation {
    pub fn admit(capacity: Arc<Semaphore>) -> AppResult<Self> {
        Ok(Self(Ticket {
            cancelled: Arc::new(AtomicBool::new(false)),
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
        self.0.cancelled.store(true, Ordering::Release);
    }
}
impl Ticket {
    pub fn check(&self) -> AppResult<()> {
        if self.cancelled.load(Ordering::Acquire) {
            Err(AppError::validation("plugin.api.cancelled"))
        } else {
            Ok(())
        }
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
}
