//! One runner with lossless wake handoff; no database or platform work in lock.
use crate::services::operations::WorkLifetime;
use std::sync::{Arc, Mutex};

#[derive(Default)]
pub(super) struct Wake(Mutex<State>);
#[derive(Default)]
struct State {
    running: bool,
    requested: bool,
    // A late producer joins every still-active cleanup worker, including an
    // orphan whose coordinator was aborted after admitting actual OS IO.
    effects: Vec<WorkLifetime>,
    workers: usize,
}
struct Worker {
    wake: Arc<Wake>,
}
impl Drop for Worker {
    fn drop(&mut self) {
        let mut state = self.wake.0.lock().unwrap_or_else(|e| e.into_inner());
        state.workers -= 1;
        let effects = if !state.running && state.workers == 0 {
            std::mem::take(&mut state.effects)
        } else {
            Vec::new()
        };
        drop(state);
        drop(effects);
    }
}
impl Wake {
    pub(super) fn request(&self) -> bool {
        let mut state = self.0.lock().unwrap_or_else(|error| error.into_inner());
        let work = WorkLifetime::current();
        if !work.is_empty() {
            state.effects.push(work.retirement());
        }
        if state.running {
            state.requested = true;
            false
        } else {
            state.running = true;
            state.requested = false;
            true
        }
    }
    pub(super) fn work(self: &Arc<Self>) -> WorkLifetime {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).workers += 1;
        WorkLifetime::new(Worker { wake: self.clone() })
    }
    pub(super) fn next(&self, more: bool) -> bool {
        let mut state = self.0.lock().unwrap_or_else(|error| error.into_inner());
        if more || state.requested {
            state.requested = false;
            true
        } else {
            state.running = false;
            let effects = if state.workers == 0 {
                std::mem::take(&mut state.effects)
            } else {
                Vec::new()
            };
            drop(state);
            drop(effects); // Never retire a native fence under the wake mutex.
            false
        }
    }
    pub(super) fn abort(&self) {
        let mut state = self.0.lock().unwrap_or_else(|error| error.into_inner());
        state.running = false;
        let effects = if state.workers == 0 {
            std::mem::take(&mut state.effects)
        } else {
            Vec::new()
        };
        drop(state);
        // A still-running blocking worker retains all current and late
        // producers; aborting the coordinator does not settle its OS IO.
        drop(effects);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn wake_before_empty_handoff_stays_with_runner_and_after_handoff_starts_new_runner() {
        let wake = Wake::default();
        assert!(wake.request());
        assert!(!wake.request());
        assert!(wake.next(false));
        assert!(!wake.next(false));
        assert!(wake.request());
        assert!(!wake.next(false));
    }
    #[test]
    fn page_limit_continues_without_losing_new_work_and_abort_allows_later_schedule() {
        let wake = Wake::default();
        assert!(wake.request());
        assert!(wake.next(true));
        assert!(!wake.request());
        wake.abort();
        assert!(wake.request());
        assert!(!wake.next(false));
    }

    #[tokio::test]
    async fn cancelled_coordinator_and_late_producers_keep_fences_until_actual_worker_settlement() {
        use crate::services::operations::{Budget, Errors};
        use std::time::Duration;
        let wake = Arc::new(Wake::default());
        let first = Arc::new(());
        let weak_first = Arc::downgrade(&first);
        WorkLifetime::new(first)
            .scope(async {
                assert!(wake.request());
            })
            .await;
        let (entered, admitted) = tokio::sync::oneshot::channel();
        let (release, released) = std::sync::mpsc::channel();
        let work = wake.work();
        let runner = tokio::spawn(work.scope(async move {
            Budget::new(
                1,
                Errors {
                    domain: "test",
                    busy: "busy",
                    cancelled: "cancelled",
                    failed: "failed",
                },
            )
            .blocking(move |job| {
                job.commit()?;
                entered.send(()).unwrap();
                released.recv_timeout(Duration::from_secs(5)).unwrap();
                Ok(())
            })
            .await
        }));
        admitted.await.unwrap();
        runner.abort();
        assert!(runner.await.unwrap_err().is_cancelled());
        wake.abort();
        let late = Arc::new(());
        let weak_late = Arc::downgrade(&late);
        WorkLifetime::new(late)
            .scope(async {
                assert!(wake.request());
            })
            .await;
        // A replacement runner finding no unclaimed records cannot settle the
        // original admitted OS deletion, nor the late producer it may service.
        assert!(!wake.next(false));
        assert!(weak_first.upgrade().is_some());
        assert!(weak_late.upgrade().is_some());
        release.send(()).unwrap();
        for _ in 0..500 {
            if weak_first.upgrade().is_none() && weak_late.upgrade().is_none() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
        panic!("actual worker did not retire both fences");
    }
}
