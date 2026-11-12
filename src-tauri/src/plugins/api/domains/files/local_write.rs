//! Local plugin checks stay outside the final synchronous publication gate.
use super::{text::validate_text, write_policy::Authorization};
use crate::{
    error::AppResult, plugins::api::HostContext, services::files::operations::Cancellation,
    ssh::files::local_editor::policy::Policy,
};
use std::path::Path;

pub(super) struct LocalPolicy<F> {
    authorization: Authorization,
    check_scope: F,
}

impl<F> LocalPolicy<F> {
    pub fn new(context: &HostContext, check_scope: F) -> Self {
        Self {
            authorization: Authorization::new(context, "fs.write"),
            check_scope,
        }
    }
}

impl<F: Fn(&Path, &str) -> AppResult<()>> Policy for LocalPolicy<F> {
    fn authorize(&self) -> AppResult<()> {
        self.authorization.check()
    }
    fn check(&self, target: &Path, original: &str) -> AppResult<()> {
        self.authorization.check()?;
        validate_text(original.as_bytes())?;
        (self.check_scope)(target, original)?;
        self.authorization.check()
    }
    fn admit(&self, job: &Cancellation) -> AppResult<()> {
        self.authorization.admit(job, || Ok(()))
    }
}
