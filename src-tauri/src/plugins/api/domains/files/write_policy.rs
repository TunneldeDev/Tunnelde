//! Shared plugin/runtime/request publication admission, with no filesystem I/O.
use crate::{
    error::AppResult,
    plugins::{
        api::{authorize, HostContext},
        security::Lease,
        tools,
    },
    services::files::operations::Cancellation,
    state::AppState,
};
use tauri::Manager;

pub(super) struct Authorization {
    pub context: HostContext,
    permission: &'static str,
}

impl Authorization {
    pub fn new(context: &HostContext, permission: &'static str) -> Self {
        Self {
            context: context.clone(),
            permission,
        }
    }

    pub fn check(&self) -> AppResult<()> {
        authorize(&self.context, &[self.permission])?;
        tools::with_request_authorized(
            &self.context.id,
            self.context.generation,
            self.context.tool_client.as_deref(),
            self.context.tool_request,
            || Ok(()),
        )
    }

    /// Lock order is runtime -> client/request -> optional domain metadata.
    /// The callback must be synchronous, must not reenter these gates and must
    /// not perform filesystem/network I/O. All target checks precede this gate.
    pub fn admit(
        &self,
        job: &Cancellation,
        validate: impl FnOnce() -> AppResult<()>,
    ) -> AppResult<()> {
        self.with_authorized(|| {
            validate()?;
            job.commit()
        })
    }

    /// Recheck runtime and request ownership for each later composite step.
    pub fn with_authorized(&self, validate: impl FnOnce() -> AppResult<()>) -> AppResult<()> {
        let lease = Lease {
            id: self.context.id.clone(),
            fingerprint: self.context.fingerprint.clone(),
            permissions: self.context.permissions.clone(),
            generation: self.context.generation,
        };
        self.context
            .app
            .state::<AppState>()
            .plugins
            .security
            .with_authorized(&lease, &[self.permission], || {
                tools::with_request_authorized(
                    &lease.id,
                    lease.generation,
                    self.context.tool_client.as_deref(),
                    self.context.tool_request,
                    validate,
                )
            })
    }
}
