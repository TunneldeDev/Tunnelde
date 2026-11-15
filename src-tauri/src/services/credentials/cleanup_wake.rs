//! One runner with lossless wake handoff; no database or platform work in lock.
use std::sync::Mutex;

#[derive(Default)]
pub(super) struct Wake(Mutex<State>);
#[derive(Default)]
struct State {
    running: bool,
    requested: bool,
}
impl Wake {
    pub(super) fn request(&self) -> bool {
        let mut state = self.0.lock().unwrap_or_else(|error| error.into_inner());
        if state.running {
            state.requested = true;
            false
        } else {
            state.running = true;
            state.requested = false;
            true
        }
    }
    pub(super) fn next(&self, more: bool) -> bool {
        let mut state = self.0.lock().unwrap_or_else(|error| error.into_inner());
        if more || state.requested {
            state.requested = false;
            true
        } else {
            state.running = false;
            false
        }
    }
    pub(super) fn abort(&self) {
        self.0
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .running = false;
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
}
