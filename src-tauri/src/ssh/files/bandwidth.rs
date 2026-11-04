use super::*;
use std::collections::HashMap;
use std::sync::Mutex;
use tokio::time::{Duration, Instant};

pub const MAX_KIB: u32 = 1_048_576;

#[derive(Clone, Copy)]
pub(super) enum Direction {
    Upload = 0,
    Download = 1,
    Both = 2,
}

struct Bucket {
    rate: u32,
    credit: f64,
    updated: Instant,
}

impl Default for Bucket {
    fn default() -> Self {
        Self {
            rate: 0,
            credit: 0.0,
            updated: Instant::now(),
        }
    }
}

impl Bucket {
    fn set(&mut self, kib: u32) {
        if self.rate != kib {
            self.rate = kib;
            self.credit = 0.0;
            self.updated = Instant::now();
        }
    }

    fn refill(&mut self, now: Instant) {
        let rate = f64::from(self.rate) * 1024.0;
        self.credit =
            (self.credit + now.duration_since(self.updated).as_secs_f64() * rate).min(rate / 10.0);
        self.updated = now;
    }
}

#[derive(Default)]
struct Budgets {
    global: [Bucket; 2],
    tasks: HashMap<String, [Bucket; 2]>,
}

/// Shared by every transfer and every data channel. Permits are issued before
/// network IO, with at most 100 ms of idle credit, rather than sleeping after IO.
#[derive(Default)]
pub struct Controller(Mutex<Budgets>);

impl Controller {
    pub fn configure(&self, upload: u32, download: u32) {
        let mut budgets = self.0.lock().unwrap_or_else(|e| e.into_inner());
        budgets.global[0].set(upload.min(MAX_KIB));
        budgets.global[1].set(download.min(MAX_KIB));
    }

    pub(super) fn register(&self, id: &str) {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .tasks
            .insert(id.into(), Default::default());
    }

    pub(super) fn remove(&self, id: &str) {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .tasks
            .remove(id);
    }

    pub(super) fn set_task(&self, id: &str, kib: u32) -> AppResult<()> {
        if kib > MAX_KIB {
            return Err(AppError::validation("sftp.invalidSpeedLimit"));
        }
        let mut budgets = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let task = budgets
            .tasks
            .get_mut(id)
            .ok_or_else(|| AppError::validation("sftp.transferNotFound"))?;
        for bucket in task {
            bucket.set(kib);
        }
        Ok(())
    }

    fn claim(&self, id: &str, direction: Direction, requested: usize) -> (usize, Duration) {
        let now = Instant::now();
        let mut budgets = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let Budgets { global, tasks } = &mut *budgets;
        let [upload, download] = global;
        let (task_upload, task_download) = match tasks.get_mut(id) {
            Some([upload, download]) => (Some(upload), Some(download)),
            None => (None, None),
        };
        let mut buckets = match direction {
            Direction::Upload => [Some(upload), task_upload, None, None],
            Direction::Download => [Some(download), task_download, None, None],
            Direction::Both => [Some(upload), Some(download), task_upload, task_download],
        };
        let mut allowed = requested as f64;
        let mut minimum = requested as f64;
        for bucket in buckets.iter_mut().flatten().filter(|b| b.rate != 0) {
            bucket.refill(now);
            allowed = allowed.min(bucket.credit.floor());
            minimum = minimum.min((f64::from(bucket.rate) * 1024.0 / 50.0).floor().max(1.0));
        }
        if allowed >= minimum {
            let bytes = allowed as usize;
            for bucket in buckets.iter_mut().flatten().filter(|b| b.rate != 0) {
                bucket.credit -= bytes as f64;
            }
            return (bytes, Duration::ZERO);
        }
        let mut wait = 0.001_f64;
        for bucket in buckets.iter().flatten().filter(|b| b.rate != 0) {
            wait = wait.max((minimum - bucket.credit).max(0.0) / (f64::from(bucket.rate) * 1024.0));
        }
        (0, Duration::from_secs_f64(wait.min(0.04)))
    }

    pub(super) async fn acquire(
        &self,
        id: &str,
        direction: Direction,
        requested: usize,
        cancel: &AtomicBool,
    ) -> AppResult<usize> {
        loop {
            if cancel.load(Ordering::SeqCst) {
                return Err(AppError::Ssh(CANCELLED.into()));
            }
            let (bytes, wait) = self.claim(id, direction, requested);
            if bytes > 0 || requested == 0 {
                return Ok(bytes);
            }
            tokio::time::sleep(wait).await;
        }
    }
}

#[derive(Clone)]
pub(super) struct Throttle {
    pub controller: Arc<Controller>,
    pub id: String,
}

impl Throttle {
    pub fn limited(&self, direction: Direction) -> bool {
        let budgets = self.controller.0.lock().unwrap_or_else(|e| e.into_inner());
        let applicable = |pair: &[Bucket; 2]| match direction {
            Direction::Upload => pair[0].rate != 0,
            Direction::Download => pair[1].rate != 0,
            Direction::Both => pair.iter().any(|bucket| bucket.rate != 0),
        };
        applicable(&budgets.global) || budgets.tasks.get(&self.id).is_some_and(applicable)
    }

    pub async fn acquire(
        &self,
        direction: Direction,
        bytes: usize,
        cancel: &AtomicBool,
    ) -> AppResult<usize> {
        self.controller
            .acquire(&self.id, direction, bytes, cancel)
            .await
    }
}

#[tauri::command]
pub fn transfer_set_speed_limit(app: AppHandle, id: String, kib: u32) -> AppResult<()> {
    let state = app.state::<AppState>();
    state.transfers.bandwidth.set_task(&id, kib)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn concurrent_tasks_share_upload_budget_and_download_is_independent() {
        let control = Arc::new(Controller::default());
        control.configure(128, 0);
        control.register("a");
        control.register("b");
        let consume = |id: &'static str| {
            let control = control.clone();
            async move {
                let mut remaining = 32 * 1024;
                while remaining > 0 {
                    remaining -= control
                        .acquire(id, Direction::Upload, remaining, &AtomicBool::new(false))
                        .await
                        .unwrap();
                }
            }
        };
        let start = Instant::now();
        tokio::join!(consume("a"), consume("b"));
        assert!(start.elapsed() >= Duration::from_millis(470));
        assert_eq!(
            control.claim("a", Direction::Download, 1024 * 1024).0,
            1024 * 1024
        );
    }

    #[tokio::test]
    async fn task_limits_cannot_bypass_global_and_live_changes_wake_throttled_work() {
        let control = Arc::new(Controller::default());
        control.register("a");
        control.configure(1, 0);
        control.set_task("a", 4096).unwrap();
        assert_eq!(control.claim("a", Direction::Upload, 4096).0, 0);
        control.configure(0, 0);
        control.set_task("a", 1).unwrap();
        assert_eq!(control.claim("a", Direction::Download, 4096).0, 0);
        let cancel = AtomicBool::new(false);
        let waiting = control.acquire("a", Direction::Download, 4096, &cancel);
        tokio::pin!(waiting);
        assert!(futures_util::poll!(&mut waiting).is_pending());
        control.set_task("a", 0).unwrap();
        assert_eq!(
            tokio::time::timeout(Duration::from_millis(250), waiting)
                .await
                .unwrap()
                .unwrap(),
            4096
        );
        control.remove("a");
        assert!(control.set_task("a", 1).is_err());
        assert!(control.set_task("missing", MAX_KIB + 1).is_err());
    }

    #[tokio::test]
    async fn cancellation_interrupts_a_low_speed_wait_and_idle_credit_is_bounded() {
        let control = Controller::default();
        control.configure(1, 0);
        control.register("a");
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert!(control.claim("a", Direction::Upload, 1024).0 <= 103);
        let stop = AtomicBool::new(false);
        let waiting = control.acquire("a", Direction::Upload, 1024, &stop);
        let cancel = async {
            tokio::time::sleep(Duration::from_millis(2)).await;
            stop.store(true, Ordering::SeqCst);
        };
        let start = Instant::now();
        let (result, ()) = tokio::join!(waiting, cancel);
        assert!(result.is_err());
        assert!(start.elapsed() < Duration::from_millis(250));
    }
}
