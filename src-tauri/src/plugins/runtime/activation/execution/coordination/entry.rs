use std::sync::{Arc, Mutex};
use tokio::sync::{watch, OwnedSemaphorePermit};

use crate::{
    error::{AppError, AppResult},
    plugins::PluginInfo,
};

type Outcome = Result<PluginInfo, Arc<AppError>>;

#[derive(Default)]
struct State {
    waiters: usize,
    cancelled: bool,
    finished: bool,
}

pub(super) struct Entry {
    state: Mutex<State>,
    pub(super) cancelled: watch::Sender<bool>,
    result: watch::Sender<Option<Outcome>>,
}

pub(in crate::plugins) struct Ticket {
    entry: Arc<Entry>,
    _permit: OwnedSemaphorePermit,
}

impl Entry {
    pub(super) fn new() -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(State::default()),
            cancelled: watch::channel(false).0,
            result: watch::channel(None).0,
        })
    }

    pub(super) fn ticket(self: &Arc<Self>, permit: OwnedSemaphorePermit) -> AppResult<Ticket> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.cancelled {
            return Err(AppError::validation("pluginSecurity.changed"));
        }
        if state.waiters >= super::MAX_WAITERS_PER_START {
            return Err(AppError::validation("plugin.api.busy"));
        }
        state.waiters += 1;
        Ok(Ticket {
            entry: self.clone(),
            _permit: permit,
        })
    }

    pub(super) fn cancel(&self) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if !state.finished {
            state.cancelled = true;
            self.cancelled.send_replace(true);
        }
    }

    pub(super) fn finish(&self, result: AppResult<PluginInfo>) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.finished = true;
        self.result.send_replace(Some(result.map_err(Arc::new)));
    }
}

impl Ticket {
    pub(in crate::plugins) async fn wait(self) -> AppResult<PluginInfo> {
        let mut result = self.entry.result.subscribe();
        loop {
            if let Some(outcome) = result.borrow_and_update().clone() {
                return outcome.map_err(AppError::Shared);
            }
            result
                .changed()
                .await
                .map_err(|_| AppError::internal("plugin.activation.closed"))?;
        }
    }
}

impl Drop for Ticket {
    fn drop(&mut self) {
        let mut state = self.entry.state.lock().unwrap_or_else(|e| e.into_inner());
        state.waiters -= 1;
        if state.waiters == 0 && !state.finished {
            state.cancelled = true;
            self.entry.cancelled.send_replace(true);
        }
    }
}
