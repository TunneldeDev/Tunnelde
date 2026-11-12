//! Optimistic remote staging and atomic publication; no truncate fallback.
use super::*;
use crate::services::files::operations::Cancellation;
use russh_sftp::protocol::FileAttributes;

pub(super) struct Draft<'a> {
    pub requested: &'a str,
    pub target: &'a str,
    pub content: &'a str,
    pub baseline: &'a str,
}

fn same_metadata(a: &FileAttributes, b: &FileAttributes) -> bool {
    a.size == b.size
        && a.mtime == b.mtime
        && a.permissions == b.permissions
        && a.uid == b.uid
        && a.gid == b.gid
}

async fn exclusive_write(sftp: &SftpSession, path: &str, content: &[u8]) -> AppResult<()> {
    let mut file = sftp
        .open_with_flags_and_attributes(
            path,
            OpenFlags::READ | OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::EXCLUDE,
            FileAttributes {
                permissions: Some(0o600),
                ..Default::default()
            },
        )
        .await
        .map_err(map_sftp)?;
    let result = async {
        file.write_all(content).await?;
        file.flush().await?;
        file.sync_all().await.map_err(map_sftp)
    }
    .await;
    let closed = file.close().await;
    result?;
    closed?;
    Ok(())
}

pub(super) async fn staged_save(
    sftp: &SftpSession,
    replacement: &remote_commit::Replacement,
    draft: Draft<'_>,
    record: &Record,
    job: &Cancellation,
) -> AppResult<()> {
    let Draft {
        requested,
        target,
        content,
        baseline,
    } = draft;
    job.check()?;
    let metadata = sftp.symlink_metadata(target).await.map_err(map_sftp)?;
    if !metadata.is_regular() {
        return Err(AppError::validation("sftp.notRegularFile"));
    }
    // Respect file access rights even if the parent directory permits replacement.
    let probe = sftp
        .open_with_flags(target, OpenFlags::WRITE)
        .await
        .map_err(map_sftp)?;
    probe.close().await?;
    job.check()?;
    replacement
        .raw()
        .mkdir(
            &record.directory,
            FileAttributes {
                permissions: Some(0o700),
                ..Default::default()
            },
        )
        .await
        .map_err(map_sftp)?;
    let private = sftp
        .symlink_metadata(&record.directory)
        .await
        .map_err(map_sftp)?;
    if !private.is_dir() || private.permissions.is_none_or(|mode| mode & 0o777 != 0o700) {
        return Err(AppError::validation("editor.privateStagingRequired"));
    }
    exclusive_write(
        sftp,
        &format!("{}/owner", record.directory),
        record.token.as_bytes(),
    )
    .await?;
    // Establish ownership even if cancellation arrived during mkdir/marker IO.
    // Cleanup may only remove paths carrying the acknowledged owner token.
    job.check()?;
    let staging = format!("{}/content", record.directory);
    exclusive_write(sftp, &staging, content.as_bytes()).await?;
    job.check()?;
    // Ownership must precede mode: chown may clear setuid/setgid bits.
    if let (Some(uid), Some(gid)) = (metadata.uid, metadata.gid) {
        sftp.set_metadata(
            &staging,
            FileAttributes {
                uid: Some(uid),
                gid: Some(gid),
                ..Default::default()
            },
        )
        .await
        .map_err(map_sftp)?;
    }
    let permissions = metadata
        .permissions
        .ok_or_else(|| AppError::validation("editor.metadataNotPreserved"))?;
    sftp.set_metadata(
        &staging,
        FileAttributes {
            permissions: Some(permissions & 0o7777),
            ..Default::default()
        },
    )
    .await
    .map_err(map_sftp)?;
    let staged = sftp.symlink_metadata(&staging).await.map_err(map_sftp)?;
    if !staged.is_regular()
        || staged.uid != metadata.uid
        || staged.gid != metadata.gid
        || staged.permissions.map(|mode| mode & 0o7777) != Some(permissions & 0o7777)
        || read_remote_text(sftp, &staging).await?.content != content
    {
        return Err(AppError::validation("editor.metadataNotPreserved"));
    }
    let current = read_remote_text(sftp, target).await?;
    let latest = sftp.symlink_metadata(target).await.map_err(map_sftp)?;
    if current.content != baseline
        || !same_metadata(&metadata, &latest)
        || sftp.canonicalize(requested).await.map_err(map_sftp)? != target
    {
        return Err(AppError::validation("editor.remoteFileChanged"));
    }
    job.commit()?;
    replacement.replace(&staging, target).await
}
