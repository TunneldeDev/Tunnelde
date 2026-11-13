//! Live request admission is separate from evidence of original completion.
use super::*;

#[derive(Clone)]
pub(super) struct Authorization(Arc<dyn Fn() -> AppResult<()> + Send + Sync>);

impl Authorization {
    pub(super) fn new(validate: impl Fn() -> AppResult<()> + Send + Sync + 'static) -> Self {
        Self(Arc::new(validate))
    }

    pub(super) fn check(&self) -> AppResult<()> {
        (self.0)()
    }
}

// Protocol-only adapters cannot return AppError. Preserve its actionable reason
// rather than misclassifying a local denial as a server terminal rejection.
pub(super) fn protocol(error: AppError) -> Error {
    Error::IO(error.to_string())
}
