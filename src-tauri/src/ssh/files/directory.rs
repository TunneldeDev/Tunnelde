//! Bounded read-only directory RPCs with owned SFTP channel and library workers.
//! No user terminal/SFTP/mount transport is disconnected during cleanup.
use super::{map_sftp, requested_directory, FileEntry};
use crate::{
    error::{AppError, AppResult},
    services::operations::{Budget, Cancellation, Errors, WorkLifetime},
};
use russh::{client, ChannelMsg};
use russh_sftp::{client::RawSftpSession, protocol::StatusCode};
use serde_json::{json, Value};
use std::{
    sync::{Arc, LazyLock},
    time::Duration,
};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

#[cfg(test)]
pub(crate) mod tests;
mod transport;

pub(crate) trait Policy: Send + Sync + 'static {
    fn check(&self) -> AppResult<()>;
}
impl<F: Fn() -> AppResult<()> + Send + Sync + 'static> Policy for F {
    fn check(&self) -> AppResult<()> {
        self()
    }
}
#[derive(Clone)]
pub(crate) enum Query {
    Resolve { path: Option<String> },
    Browse { path: Option<String>, offset: usize },
}
impl Query {
    fn path(&self) -> Option<&str> {
        match self {
            Self::Resolve { path } | Self::Browse { path, .. } => path.as_deref(),
        }
    }
    pub(crate) fn validate(&self) -> AppResult<()> {
        if self
            .path()
            .is_some_and(|p| p.len() > 2048 || p.contains(['\0', '\r', '\n']))
        {
            return Err(AppError::validation("mounts.remotePath.invalid"));
        }
        Ok(())
    }
}
const DEADLINE: Duration = Duration::from_secs(15);
const ERRORS: Errors = Errors {
    domain: "mounts.remote.paths",
    busy: "mounts.pathBusy",
    cancelled: "mounts.pathTimeout",
    failed: "mounts.pathTimeout",
};
static WORKERS: LazyLock<Budget> = LazyLock::new(|| Budget::new(4, ERRORS));
static CHANNELS: LazyLock<Arc<Semaphore>> = LazyLock::new(|| Arc::new(Semaphore::new(8)));

pub(crate) async fn query<H: client::Handler + 'static>(
    handle: Arc<client::Handle<H>>,
    query: Query,
    policy: impl Policy,
) -> AppResult<Value> {
    query.validate()?;
    policy.check()?;
    let permit = CHANNELS
        .clone()
        .try_acquire_owned()
        .map_err(|_| AppError::validation("mounts.pathBusy"))?;
    // Timeout is delivery-only. An outstanding OPEN or peer close keeps its
    // explicit channel slot AND the inherited native effect until settlement.
    tokio::time::timeout(
        DEADLINE,
        WORKERS.asynchronous(move |cancel| async move {
            on(handle, query, policy, cancel, permit, DEADLINE).await
        }),
    )
    .await
    .map_err(|_| AppError::validation("mounts.pathTimeout"))?
}
async fn on<H: client::Handler + 'static>(
    handle: Arc<client::Handle<H>>,
    query: Query,
    policy: impl Policy,
    cancel: Cancellation,
    permit: OwnedSemaphorePermit,
    deadline: Duration,
) -> AppResult<Value> {
    query.validate()?;
    check(&policy, &cancel)?;
    let opening = crate::ssh::channel::open(
        async move {
            handle
                .channel_open_session()
                .await
                .map_err(|e| AppError::Ssh(format!("sftp.channel: {e}")))
        },
        permit,
    );
    let mut owned = tokio::time::timeout(deadline, opening)
        .await
        .map_err(|_| AppError::validation("mounts.pathTimeout"))??;
    // Explicit finish on all confirmed-channel errors, not close-on-drop-only.
    let negotiation = tokio::time::timeout(deadline, async {
        check(&policy, &cancel)?;
        owned
            .channel()
            .request_subsystem(true, "sftp")
            .await
            .map_err(|e| AppError::Ssh(format!("sftp.subsystem: {e}")))?;
        let mut diagnostics = 0usize;
        loop {
            check(&policy, &cancel)?;
            match owned.channel().wait().await {
                Some(ChannelMsg::Success) => return Ok(()),
                Some(ChannelMsg::ExtendedData { data, .. }) => {
                    diagnostics = diagnostics.saturating_add(data.len());
                    if diagnostics > 16 * 1024 {
                        return Err(AppError::validation("mounts.subsystemProtocol"));
                    }
                }
                Some(ChannelMsg::Failure) => {
                    return Err(AppError::validation("mounts.subsystemRejected"))
                }
                Some(ChannelMsg::Data { .. }) => {
                    return Err(AppError::validation("mounts.subsystemProtocol"))
                }
                Some(ChannelMsg::Close | ChannelMsg::Eof) | None => {
                    return Err(AppError::validation("mounts.transportClosed"))
                }
                _ => {}
            }
        }
    })
    .await
    .map_err(|_| AppError::validation("mounts.pathTimeout"))
    .and_then(|r| r);
    if let Err(error) = negotiation {
        owned.split().finish().await;
        return Err(error);
    }
    let transport = transport::Session::new(owned.split());
    let result = tokio::time::timeout(deadline, read(&transport.raw, &query, &policy, &cancel))
        .await
        .map_err(|_| AppError::validation("mounts.pathTimeout"))
        .and_then(|r| r);
    transport.finish().await;
    check(&policy, &cancel)?;
    result
}
fn check(policy: &impl Policy, cancel: &Cancellation) -> AppResult<()> {
    policy.check()?;
    cancel.check()
}
async fn read(
    raw: &RawSftpSession,
    query: &Query,
    policy: &impl Policy,
    cancel: &Cancellation,
) -> AppResult<Value> {
    check(policy, cancel)?;
    raw.init().await.map_err(map_sftp)?;
    check(policy, cancel)?;
    let home = canonical(raw, ".".into()).await?;
    let requested = requested_directory(&home, query.path())?;
    check(policy, cancel)?;
    let path = canonical(raw, requested).await?;
    check(policy, cancel)?;
    if !raw
        .stat(path.clone())
        .await
        .map_err(map_sftp)?
        .attrs
        .file_type()
        .is_dir()
    {
        return Err(AppError::validation("plugin.tools.invalidPath"));
    }
    let Query::Browse { offset, .. } = query else {
        return Ok(json!({"home":home,"path":path}));
    };
    check(policy, cancel)?;
    let directory = raw.opendir(path.clone()).await.map_err(map_sftp)?.handle;
    let result = entries(raw, &directory, &path, *offset, policy, cancel).await;
    // Closing the whole SSH channel still reclaims a handle after timeout or
    // malformed replies. Attempt normal CLOSE before shutting down its worker.
    let close = raw.close(directory).await.map_err(map_sftp);
    result.and_then(|value| close.map(|_| value))
}
async fn canonical(raw: &RawSftpSession, path: String) -> AppResult<String> {
    let response = raw.realpath(path).await.map_err(map_sftp)?;
    let path = response
        .files
        .into_iter()
        .next()
        .ok_or_else(|| AppError::validation("fileRead.invalidReply"))?
        .filename;
    if !path.starts_with('/') || path.contains('\0') || path.len() > 32768 {
        return Err(AppError::validation("fileRead.invalidReply"));
    }
    Ok(path)
}
async fn entries(
    raw: &RawSftpSession,
    directory: &str,
    path: &str,
    offset: usize,
    policy: &impl Policy,
    cancel: &Cancellation,
) -> AppResult<Value> {
    let mut result = Vec::<FileEntry>::new();
    let (mut count, mut bytes) = (0usize, 0usize);
    loop {
        check(policy, cancel)?;
        let response = match raw.readdir(directory).await {
            Ok(response) => response,
            Err(russh_sftp::client::error::Error::Status(status))
                if status.status_code == StatusCode::Eof =>
            {
                break
            }
            Err(error) => return Err(map_sftp(error)),
        };
        // Empty non-EOF pages and hostile endless listings remain bounded by
        // the whole query deadline, entry count AND decoded string bytes.
        for file in response.files {
            count = count.saturating_add(1);
            bytes = bytes
                .saturating_add(file.filename.len())
                .saturating_add(file.longname.len());
            if count > 65536 || bytes > 8 * 1024 * 1024 {
                return Err(AppError::validation("mounts.remoteListingTooLarge"));
            }
            let name = file.filename;
            if matches!(name.as_str(), "." | "..") {
                continue;
            }
            if name.is_empty() || name.contains(['/', '\0']) {
                return Err(AppError::validation("fileRead.invalidReply"));
            }
            if !file.attrs.file_type().is_dir() {
                continue;
            }
            // Canonical parent paths are repeated in each returned entry.
            // Count them too, rather than allowing a long parent to amplify
            // a small NAME packet into gigabytes of retained listing memory.
            bytes = bytes.saturating_add(path.len()).saturating_add(1);
            if bytes > 8 * 1024 * 1024 {
                return Err(AppError::validation("mounts.remoteListingTooLarge"));
            }
            result.push(FileEntry {
                is_hidden: name.starts_with('.'),
                path: format!("{}/{name}", path.trim_end_matches('/')),
                name,
                is_dir: true,
                size: file.attrs.size.unwrap_or(0),
                modified: file.attrs.mtime.map(|s| i64::from(s) * 1000),
                permissions: file.attrs.permissions,
            });
        }
    }
    result.sort_by(|a, b| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then(a.name.cmp(&b.name))
    });
    page(result, path, offset)
}
fn page(entries: Vec<FileEntry>, path: &str, offset: usize) -> AppResult<Value> {
    const RESPONSE_BYTES: usize = 512 * 1024;
    let total = entries.len();
    let mut bytes =
        serde_json::to_vec(&json!({"path":path,"entries":[],"nextOffset":usize::MAX}))?.len();
    let mut page = Vec::new();
    for entry in entries.into_iter().skip(offset).take(128) {
        let entry = serde_json::to_value(entry)?;
        let size = serde_json::to_vec(&entry)?.len() + 1;
        if bytes.saturating_add(size) > RESPONSE_BYTES {
            if page.is_empty() {
                return Err(AppError::validation("mounts.remoteListingTooLarge"));
            }
            break;
        }
        bytes += size;
        page.push(entry);
    }
    let consumed = offset.saturating_add(page.len());
    let next = (consumed < total).then_some(consumed);
    Ok(json!({"path":path,"entries":page,"nextOffset":next}))
}
