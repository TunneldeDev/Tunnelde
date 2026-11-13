//! Synchronous mutation admission; implementations never await or perform I/O.
use crate::error::AppResult;

pub(crate) trait Policy: Send + Sync + 'static {
    fn with_authorized(&self, validate: impl FnOnce() -> AppResult<()>) -> AppResult<()>;
}

pub(in super::super) struct Native;
impl Policy for Native {
    fn with_authorized(&self, validate: impl FnOnce() -> AppResult<()>) -> AppResult<()> {
        validate()
    }
}
