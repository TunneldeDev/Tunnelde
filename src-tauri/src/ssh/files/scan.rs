use super::*;
use futures_util::{stream::FuturesUnordered, StreamExt};
use russh_sftp::protocol::FileAttributes;
use std::collections::{HashSet, VecDeque};
use std::future::Future;

const CONCURRENCY: usize = 4;

struct Visit<T> {
    bytes: u64,
    children: Vec<T>,
}

fn add(total: u64, bytes: u64) -> AppResult<u64> {
    total
        .checked_add(bytes)
        .ok_or_else(|| AppError::validation("sftp.transferTooLarge"))
}

/// A single work queue bounds concurrency across the whole tree, including
/// nested directories. All operations are read-only and can be dropped when a
/// task pauses; the owner closes this dedicated metadata channel afterwards.
async fn walk<T, F, Fut>(root: T, concurrency: usize, mut inspect: F) -> AppResult<u64>
where
    F: FnMut(T) -> Fut,
    Fut: Future<Output = AppResult<Visit<T>>>,
{
    let mut queue = VecDeque::from([root]);
    let mut pending = FuturesUnordered::new();
    let mut total = 0;
    loop {
        while pending.len() < concurrency.clamp(1, CONCURRENCY) {
            let Some(item) = queue.pop_front() else {
                break;
            };
            pending.push(inspect(item));
        }
        let Some(result) = pending.next().await else {
            return Ok(total);
        };
        let result = result?;
        total = add(total, result.bytes)?;
        queue.extend(result.children);
    }
}

pub(super) enum Kind {
    File(u64),
    Directory,
}

/// READDIR attributes are optional in SFTP v3. Reuse only an unambiguous
/// regular-file type and an explicit length; otherwise request LSTAT.
pub(super) fn remote_kind(metadata: &FileAttributes) -> AppResult<Option<Kind>> {
    match metadata.permissions.map(|mode| mode & 0o170000) {
        Some(0o040000) => Ok(Some(Kind::Directory)),
        Some(0o100000) => Ok(metadata.size.map(Kind::File)),
        Some(0o120000) => Err(AppError::validation("sftp.symlinkUnsupported")),
        None | Some(0) => Ok(None),
        _ => Err(AppError::validation("sftp.fileTypeUnsupported")),
    }
}

pub(super) fn local_kind(metadata: &std::fs::Metadata) -> AppResult<Kind> {
    if local_metadata_is_link(metadata) {
        return Err(AppError::validation("sftp.symlinkUnsupported"));
    }
    if metadata.is_dir() {
        Ok(Kind::Directory)
    } else if metadata.is_file() {
        Ok(Kind::File(metadata.len()))
    } else {
        Err(AppError::validation("sftp.fileTypeUnsupported"))
    }
}

async fn inspect(endpoint: Endpoint, sftp: Option<&SftpSession>) -> AppResult<Visit<Endpoint>> {
    let mut result = Visit {
        bytes: 0,
        children: Vec::new(),
    };
    if let Some(sftp) = sftp {
        let metadata = sftp
            .symlink_metadata(&endpoint.path)
            .await
            .map_err(map_sftp)?;
        match remote_kind(&metadata)? {
            Some(Kind::File(bytes)) => result.bytes = bytes,
            Some(Kind::Directory) => {
                let mut names = HashSet::new();
                for entry in sftp.read_dir(&endpoint.path).await.map_err(map_sftp)? {
                    let name = entry.file_name();
                    if name.is_empty() || name.contains(['/', '\0']) || !names.insert(name) {
                        return Err(AppError::validation("sftp.resumeSourceChanged"));
                    }
                    match remote_kind(&entry.metadata())? {
                        Some(Kind::File(bytes)) => result.bytes = add(result.bytes, bytes)?,
                        // Recheck directories before traversing. Listing hints
                        // are not a file-identity or symlink-safety guarantee.
                        Some(Kind::Directory) | None => {
                            result.children.push(endpoint.child(entry.path()))
                        }
                    }
                }
            }
            None => return Err(AppError::validation("sftp.fileMetadataMissing")),
        }
    } else {
        let metadata = tokio::fs::symlink_metadata(&endpoint.path).await?;
        match local_kind(&metadata)? {
            Kind::Directory => {
                let mut directory = tokio::fs::read_dir(&endpoint.path).await?;
                while let Some(entry) = directory.next_entry().await? {
                    result
                        .children
                        .push(endpoint.child(display_path(&entry.path())));
                }
            }
            Kind::File(bytes) => result.bytes = bytes,
        }
    }
    Ok(result)
}

/// This total is a progress estimate, not a content snapshot. The copy/resume
/// protocol still revalidates every source before reading and publishing it.
pub(super) async fn measure(
    endpoint: &Endpoint,
    sftp: Option<&SftpSession>,
    concurrency: usize,
) -> AppResult<u64> {
    walk(endpoint.clone(), concurrency, |node| inspect(node, sftp)).await
}

#[cfg(test)]
mod tests;
