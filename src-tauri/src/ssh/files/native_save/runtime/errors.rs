//! Fixed diagnostic keys only; private protocol requests and tokens never cross IPC/logs.
use super::super::{
    journal::Error,
    service,
    transport::{Failure, Reason},
};
use crate::error::AppError;
pub(super) fn journal(error: Error) -> &'static str {
    match error {
        Error::Capacity => "editor.nativeBusy",
        Error::SecretUnavailable => "editor.nativeSecretUnavailable",
        Error::SecretChanged => "editor.nativeSecretChanged",
        Error::Occupied => "editor.remoteOutcomeUnknown",
        Error::Changed | Error::NotDispatched => "editor.nativeChanged",
        Error::Unavailable | Error::Unrecognized => "editor.nativeJournalUnavailable",
    }
}
pub(in crate::ssh::files::native_save) fn app_journal(error: Error) -> AppError {
    AppError::validation(journal(error))
}
pub(in crate::ssh::files::native_save) fn app_remote(failure: Failure) -> AppError {
    AppError::validation(match failure.reason {
        Reason::AuthorityChanged => "editor.nativeAuthorityChanged",
        Reason::MissingOperation => "editor.nativeMissingOperation",
        Reason::Transport | Reason::Timeout => "editor.nativeReconnect",
        _ => "editor.nativeProtocolRejected",
    })
}
pub(super) fn app_service(error: service::Error) -> AppError {
    match error {
        service::Error::Journal(error) => app_journal(error),
        service::Error::Remote(error) => app_remote(error),
    }
}
