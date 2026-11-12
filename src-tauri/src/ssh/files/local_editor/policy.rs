//! Synchronous checks and publication admission; filesystem checks stay outside gates.
use crate::{error::AppResult, services::files::operations::Cancellation};
use std::path::Path;

pub(crate) trait Policy {
    fn authorize(&self) -> AppResult<()> {
        Ok(())
    }
    fn check(&self, target: &Path, original: &str) -> AppResult<()>;
    fn admit(&self, job: &Cancellation) -> AppResult<()>;
}

pub(crate) struct Native;
impl Policy for Native {
    fn check(&self, _: &Path, _: &str) -> AppResult<()> {
        Ok(())
    }
    fn admit(&self, job: &Cancellation) -> AppResult<()> {
        job.commit()
    }
}

#[cfg(test)]
pub(super) struct Checked<F>(pub F);
#[cfg(test)]
impl<F: Fn(&Path, &str) -> AppResult<()>> Policy for Checked<F> {
    fn check(&self, target: &Path, original: &str) -> AppResult<()> {
        (self.0)(target, original)
    }
    fn admit(&self, job: &Cancellation) -> AppResult<()> {
        job.commit()
    }
}
