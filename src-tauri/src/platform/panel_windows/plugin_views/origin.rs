//! Private task-local origin of admitted native-view RPC. Never serialized,
//! inherited by spawned tasks or accepted from a plugin's request parameters.
use super::Ownership;
use crate::platform::panel_windows::native;
use crate::{
    error::{AppError, AppResult},
    plugins::{frontend::native::CallPolicy, security::Lease},
};
use std::future::Future;
use tauri::{AppHandle, Manager};

#[derive(Clone)]
pub(crate) struct Origin {
    app: AppHandle,
    pub(super) window: String,
    pub(super) document: String,
    pub(super) token: String,
    pub(super) plugin: Lease,
}
impl Origin {
    pub(super) fn new(
        app: AppHandle,
        window: String,
        document: String,
        token: String,
        plugin: Lease,
    ) -> Self {
        Self {
            app,
            window,
            document,
            token,
            plugin,
        }
    }
    pub(crate) fn with_current<T>(&self, operation: impl FnOnce() -> AppResult<T>) -> AppResult<T> {
        let registry = self.app.state::<native::Registry>();
        let ownership = native::lock(&registry);
        self.authorize(&ownership)?;
        // Ownership -> plugin policy -> domain registry. Never await, emit,
        // invoke JS or acquire ownership again inside this synchronous gate.
        operation()
    }
    pub(super) fn authorize(&self, ownership: &Ownership) -> AppResult<()> {
        ownership.native_provider_current(&self.app, &self.window, &self.document, &self.token)?;
        let plugin = ownership
            .native_view_resource(
                &self.window,
                &self.document,
                &self.token,
                std::time::Instant::now(),
            )
            .map_err(native::invalid)?;
        if plugin != self.plugin {
            return Err(AppError::validation("plugin.frontend.expired"));
        }
        Ok(())
    }
    /// Coordinator replies have no task-local origin. Re-enter the exact native
    /// document and retain the original staged/committed call class.
    pub(crate) fn authorize_call(&self, policy: CallPolicy) -> AppResult<()> {
        let registry = self.app.state::<native::Registry>();
        let ownership = native::lock(&registry);
        ownership.native_provider_current(&self.app, &self.window, &self.document, &self.token)?;
        let plugin = ownership
            .native_view_policy_current(
                &self.window,
                &self.document,
                &self.token,
                policy,
                std::time::Instant::now(),
            )
            .map_err(native::invalid)?;
        if plugin != self.plugin {
            return Err(AppError::validation("plugin.frontend.expired"));
        }
        Ok(())
    }
}
// Database admission captures this exact origin before spawning its worker.
// The trait gate is synchronous and must surround only a nonblocking attempt.
impl crate::services::operations::Authority for Origin {
    fn with_current(&self, effect: &mut dyn FnMut() -> AppResult<()>) -> AppResult<()> {
        Origin::with_current(self, effect)
    }
}
tokio::task_local! {
    static CURRENT: Origin;
}
pub(crate) async fn scope<T>(origin: Origin, work: impl Future<Output = T>) -> T {
    CURRENT.scope(origin, work).await
}
pub(crate) fn current() -> Option<Origin> {
    CURRENT.try_with(Clone::clone).ok()
}
/// Non-native transports retain their existing domain authority. Native async
/// observers must use this at the actual consuming/committing transaction, not
/// just before waiting, so a delayed source cannot consume a new owner's data.
pub(crate) fn with_current<T>(operation: impl FnOnce() -> AppResult<T>) -> AppResult<T> {
    match CURRENT.try_with(Clone::clone).ok() {
        Some(origin) => origin.with_current(operation),
        None => operation(),
    }
}
