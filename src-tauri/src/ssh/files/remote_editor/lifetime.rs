//! Response delivery may end before the original bounded worker's observation.
use super::*;
use std::time::Duration;

type Entries = HashMap<String, Arc<AtomicBool>>;
static ACTIVE: OnceLock<Mutex<Entries>> = OnceLock::new();

#[derive(Clone, Copy)]
pub(super) struct Timing {
    pub delivery: Duration,
    pub observation: Duration,
}

pub(super) struct Observation {
    pub visible: Arc<AtomicBool>,
    pub horizon: Duration,
}

impl Default for Timing {
    fn default() -> Self {
        Self {
            delivery: Duration::from_secs(30),
            observation: Duration::from_secs(300),
        }
    }
}

pub(super) fn active() -> std::sync::MutexGuard<'static, Entries> {
    ACTIVE.get_or_init(Default::default).lock().unwrap()
}

#[cfg(test)]
pub(super) fn snapshot() -> HashMap<String, bool> {
    active()
        .iter()
        .map(|(id, visible)| (id.clone(), visible.load(Ordering::Acquire)))
        .collect()
}

pub(super) struct Reservation(String);
impl Reservation {
    pub fn acquire(id: &str, retry: bool) -> AppResult<Self> {
        Self::saving(id, Arc::new(AtomicBool::new(retry)))
    }

    pub fn saving(id: &str, visible: Arc<AtomicBool>) -> AppResult<Self> {
        let mut active = ACTIVE.get_or_init(Default::default).lock().unwrap();
        if active.contains_key(id) {
            return Err(AppError::validation("editor.cleanupBusy"));
        }
        active.insert(id.into(), visible);
        Ok(Self(id.into()))
    }
}
impl Drop for Reservation {
    fn drop(&mut self) {
        ACTIVE.get().unwrap().lock().unwrap().remove(&self.0);
    }
}

pub(super) struct Delivery<J: Journal> {
    pub journal: Arc<J>,
    pub visible: Arc<AtomicBool>,
    completed: bool,
}
impl<J: Journal> Delivery<J> {
    pub fn new(journal: J) -> Self {
        Self {
            journal: Arc::new(journal),
            visible: Arc::new(AtomicBool::new(false)),
            completed: false,
        }
    }

    pub fn complete(&mut self) {
        self.completed = true;
    }
}
impl<J: Journal> Drop for Delivery<J> {
    fn drop(&mut self) {
        if !self.completed {
            // Also runs when the RPC is dropped rather than its timer firing.
            self.visible.store(true, Ordering::Release);
            self.journal.changed();
        }
    }
}

pub(super) struct WorkerWake<J: Journal>(pub Arc<J>);
impl<J: Journal> Drop for WorkerWake<J> {
    fn drop(&mut self) {
        // Inner operation/reservation is retired before this guard, including
        // observation expiry and panics. Observers then see the final snapshot.
        self.0.changed();
    }
}
