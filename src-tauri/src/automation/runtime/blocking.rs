//! The blocking worker retains capacity after its async caller times out.
use crate::automation::contract::Failure;
use crate::error::{AppError, AppResult};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

pub(in crate::automation) struct Read(Ticket);
#[derive(Clone)]
pub(in crate::automation) struct Ticket {
    cancelled: Arc<AtomicBool>,
    cancellation_code: &'static str,
    _capacity: Arc<OwnedSemaphorePermit>,
}

impl Read {
    pub fn admit(
        capacity: Arc<Semaphore>,
        cancellation_code: &'static str,
        busy_message: &'static str,
    ) -> Result<Self, Failure> {
        let permit = capacity
            .try_acquire_owned()
            .map_err(|_| Failure::new("operation_rejected", busy_message))?;
        Ok(Self(Ticket {
            cancelled: Arc::new(AtomicBool::new(false)),
            cancellation_code,
            _capacity: Arc::new(permit),
        }))
    }
    pub fn ticket(&self) -> Ticket {
        self.0.clone()
    }
}
impl Drop for Read {
    fn drop(&mut self) {
        self.0.cancelled.store(true, Ordering::Release);
    }
}
impl Ticket {
    pub fn check(&self) -> AppResult<()> {
        if self.cancelled.load(Ordering::Acquire) {
            Err(AppError::validation(self.cancellation_code))
        } else {
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn admit(capacity: Arc<Semaphore>) -> Result<Read, Failure> {
        Read::admit(capacity, "automation.read.cancelled", "Readers are busy")
    }
    #[test]
    fn caller_cancellation_does_not_release_a_running_readers_capacity() {
        let capacity = Arc::new(Semaphore::new(1));
        let read = admit(capacity.clone()).unwrap();
        let ticket = read.ticket();
        ticket.check().unwrap();
        assert!(admit(capacity.clone()).is_err());
        drop(read);
        assert_eq!(
            ticket.check().unwrap_err().to_string(),
            "automation.read.cancelled"
        );
        assert!(admit(capacity.clone()).is_err());
        drop(ticket);
        assert!(admit(capacity).is_ok());
    }

    #[tokio::test]
    async fn aborting_the_async_owner_stops_its_blocking_worker_before_further_scans() {
        let capacity = Arc::new(Semaphore::new(1));
        let admitted = capacity.clone();
        let (started, ready) = tokio::sync::oneshot::channel();
        let (release, wait) = std::sync::mpsc::channel();
        let (finished, done) = tokio::sync::oneshot::channel();
        let caller = tokio::spawn(async move {
            let operation = admit(admitted).unwrap();
            let ticket = operation.ticket();
            tokio::task::spawn_blocking(move || {
                started.send(()).unwrap();
                wait.recv().unwrap();
                let cancelled = ticket.check().is_err();
                drop(ticket);
                finished.send(cancelled).unwrap();
            })
            .await
            .unwrap();
        });
        ready.await.unwrap();
        caller.abort();
        assert!(caller.await.unwrap_err().is_cancelled());
        assert!(admit(capacity.clone()).is_err());
        release.send(()).unwrap();
        assert!(done.await.unwrap());
        assert!(admit(capacity).is_ok());
    }
}
