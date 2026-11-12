//! Awaited target checks precede a synchronous publication-admission fence.
use crate::{error::AppResult, services::files::operations::Cancellation};
use russh_sftp::client::SftpSession;
use std::future::Future;

/// Internal native policy, not a plugin RPC. Never hold authorization locks
/// across `check`'s network awaits. `admit` orders publication against revocation;
/// it does not make the subsequent SFTP rename a server-side compare-and-swap.
pub(crate) trait Policy: Send + Sync + 'static {
    fn authorize(&self) -> AppResult<()> {
        Ok(())
    }

    fn check<'a>(
        &'a self,
        sftp: &'a SftpSession,
        target: &'a str,
        original: &'a str,
    ) -> impl Future<Output = AppResult<()>> + Send + 'a;

    fn admit(&self, job: &Cancellation) -> AppResult<()>;
}

pub(crate) struct Native;
impl Policy for Native {
    async fn check(&self, _: &SftpSession, _: &str, _: &str) -> AppResult<()> {
        Ok(())
    }

    fn admit(&self, job: &Cancellation) -> AppResult<()> {
        job.commit()
    }
}
