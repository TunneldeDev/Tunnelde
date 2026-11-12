//! No secret argv, implicit runtime, retry or assumption that channel close stopped work.
pub(super) mod ssh;
use std::future::Future;

pub(super) struct Output {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub code: Option<u32>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Reason {
    InvalidRequest,
    AuthorityChanged,
    Transport,
    Timeout,
    OutputTooLarge,
    MissingExitStatus,
    RemoteRejected,
    InvalidResponse,
    UnsupportedProtocol,
    MissingOperation,
    StaleReceipt,
    NotReleasable,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct Failure {
    pub reason: Reason,
    pub dispatched: bool,
}
impl Failure {
    pub fn before(reason: Reason) -> Self {
        Self {
            reason,
            dispatched: false,
        }
    }
}
pub(super) trait Exchange: Send + Sync {
    fn authorize(&self, context: &super::contracts::authority::Context) -> Result<(), Failure>;
    fn exchange(&self, input: Vec<u8>) -> impl Future<Output = Result<Output, Failure>> + Send;
}
