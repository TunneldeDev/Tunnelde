//! Discovery and the listener share one shutdown boundary, including startup races.
use super::location::Registration;
use std::sync::Mutex;
use tokio::sync::watch;

pub(crate) struct Lifecycle {
    registration: Mutex<RegistrationState>,
    stopped: watch::Sender<bool>,
}

#[derive(Default)]
struct RegistrationState {
    started: bool,
    current: Option<Registration>,
}

impl Default for Lifecycle {
    fn default() -> Self {
        Self {
            registration: Mutex::new(RegistrationState::default()),
            stopped: watch::channel(false).0,
        }
    }
}
impl Lifecycle {
    pub(super) fn begin(&self) -> Option<Running<'_>> {
        let mut state = self.registration.lock().unwrap_or_else(|e| e.into_inner());
        if state.started || *self.stopped.borrow() {
            return None;
        }
        state.started = true;
        Some(Running {
            lifecycle: self,
            shutdown: self.stopped.subscribe(),
        })
    }

    pub(super) fn stop(&self) {
        let mut registration = self.registration.lock().unwrap_or_else(|e| e.into_inner());
        // Retain the stopped value even if startup has not subscribed yet.
        self.stopped.send_replace(true);
        registration.current.take();
    }
}

/// The listener future owns discovery, including early errors or cancellation.
pub(super) struct Running<'a> {
    lifecycle: &'a Lifecycle,
    shutdown: watch::Receiver<bool>,
}

impl Running<'_> {
    pub(super) fn shutdown(&self) -> watch::Receiver<bool> {
        self.shutdown.clone()
    }

    pub(super) fn register(&self, registration: Registration) -> bool {
        let mut state = self
            .lifecycle
            .registration
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if *self.lifecycle.stopped.borrow() || state.current.is_some() {
            return false;
        }
        state.current = Some(registration);
        true
    }
}

impl Drop for Running<'_> {
    fn drop(&mut self) {
        self.lifecycle.stop();
    }
}

#[cfg(test)]
mod tests;
