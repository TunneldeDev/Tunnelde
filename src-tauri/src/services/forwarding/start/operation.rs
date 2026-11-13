//! One in-flight dialog operation per request. Cancellation is observed across
//! network awaits and checked again under authority before any final mutation.
use super::*;
use tokio::sync::watch;

pub(super) struct Operation {
    pub app: AppHandle,
    pub id: String,
    pub ui: String,
    pub captured: Captured,
    cancelled: watch::Receiver<bool>,
}
impl Operation {
    pub fn begin(app: &AppHandle, id: &str, ui: &str) -> AppResult<Self> {
        let state = app.state::<AppState>();
        let mut manager = state.forward_starts.lock()?;
        let entry = manager.book.get(id, Instant::now())?;
        entry.authorize_ui(ui, Instant::now())?;
        if entry.busy || entry.receipt.phase != Phase::Credentials {
            return Err(AppError::validation("forward.startBusy"));
        }
        entry.busy = true;
        Ok(Self {
            app: app.clone(),
            id: id.into(),
            ui: ui.into(),
            captured: entry.context.clone(),
            cancelled: entry.cancel.subscribe(),
        })
    }
    pub fn with_current<T>(&self, run: impl FnOnce(&mut State) -> AppResult<T>) -> AppResult<T> {
        let state = self.app.state::<AppState>();
        let mut manager = state.forward_starts.lock()?;
        let entry = manager.book.get(&self.id, Instant::now())?;
        entry.authorize_ui(&self.ui, Instant::now())?;
        if entry.context.review.identity() != self.captured.review.identity() {
            return Err(AppError::validation("ssh.connectionChanged"));
        }
        run(&mut manager)
    }
    pub fn phase(&self, phase: Phase) -> AppResult<()> {
        self.with_current(|manager| {
            manager.book.get(&self.id, Instant::now())?.receipt.phase = phase;
            Ok(())
        })?;
        changed(&self.app);
        Ok(())
    }
    pub async fn guard<T>(
        &self,
        work: impl std::future::Future<Output = AppResult<T>>,
    ) -> AppResult<T> {
        let mut cancel = self.cancelled.clone();
        if *cancel.borrow() {
            return Err(AppError::validation("forward.startExpired"));
        }
        tokio::select! { biased;
            _ = cancel.changed() => Err(AppError::validation("forward.startExpired")),
            result = work => result,
        }
    }
}
impl Drop for Operation {
    fn drop(&mut self) {
        let state = self.app.state::<AppState>();
        if let Ok(mut manager) = state.forward_starts.lock() {
            if let Ok(entry) = manager.book.get(&self.id, Instant::now()) {
                entry.busy = false;
                if !entry.receipt.phase.terminal() {
                    entry.receipt.phase = Phase::Credentials;
                }
            }
        }
        changed(&self.app);
    }
}
