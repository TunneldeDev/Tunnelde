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

pub(super) struct Observer<'a> {
    pub checkpoint: &'a (dyn Fn(&Record) -> AppResult<()> + Sync),
    pub published: &'a (dyn Fn() + Sync),
}

fn same_metadata(a: &FileAttributes, b: &FileAttributes) -> bool {
    a.size == b.size
        && a.mtime == b.mtime
        && a.permissions == b.permissions
        && a.uid == b.uid
        && a.gid == b.gid
}

pub(super) async fn staged_save(
    sftp: &SftpSession,
    replacement: &remote_commit::Replacement,
    draft: Draft<'_>,
    record: &mut Record,
    job: &Cancellation,
    policy: &impl policy::Policy,
    observer: Observer<'_>,
) -> AppResult<()> {
    let checkpoint = &observer.checkpoint;
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
    // Channel negotiation and the write-access probe may have awaited since
    // the first policy check. Revalidate before creating even private staging.
    policy.check(sftp, target, baseline).await?;
    job.check()?;
    recovery::begin(record, recovery::Operation::Create, checkpoint)?;
    let creation = replacement
        .raw()
        .mkdir(
            &record.directory,
            FileAttributes {
                permissions: Some(0o700),
                ..Default::default()
            },
        )
        .await;
    match creation {
        Ok(_) => recovery::settle(record, true, checkpoint)?,
        Err(error) => {
            if recovery::terminal(&error) {
                recovery::settle(record, false, checkpoint)?;
            }
            return Err(map_sftp(error));
        }
    }
    let private = sftp
        .symlink_metadata(&record.directory)
        .await
        .map_err(map_sftp)?;
    if !private.is_dir() || private.permissions.is_none_or(|mode| mode & 0o777 != 0o700) {
        return Err(AppError::validation("editor.privateStagingRequired"));
    }
    let marker = format!("{}/owner", record.directory);
    let token = record.token.clone();
    staging::exclusive_write(replacement, record, checkpoint, &marker, token.as_bytes()).await?;
    // Establish ownership even if cancellation arrived during mkdir/marker IO.
    // Cleanup may only remove paths carrying the acknowledged owner token.
    job.check()?;
    let staging = format!("{}/content", record.directory);
    staging::exclusive_write(
        replacement,
        record,
        checkpoint,
        &staging,
        content.as_bytes(),
    )
    .await?;
    job.check()?;
    // Ownership must precede mode: chown may clear setuid/setgid bits.
    if let (Some(uid), Some(gid)) = (metadata.uid, metadata.gid) {
        recovery::mutation(
            record,
            checkpoint,
            replacement.raw().setstat(
                &staging,
                FileAttributes {
                    uid: Some(uid),
                    gid: Some(gid),
                    ..Default::default()
                },
            ),
        )
        .await?;
    }
    let permissions = metadata
        .permissions
        .ok_or_else(|| AppError::validation("editor.metadataNotPreserved"))?;
    recovery::mutation(
        record,
        checkpoint,
        replacement.raw().setstat(
            &staging,
            FileAttributes {
                permissions: Some(permissions & 0o7777),
                ..Default::default()
            },
        ),
    )
    .await?;
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
    policy.check(sftp, target, &current.content).await?;
    policy.admit(job)?;
    recovery::begin(record, recovery::Operation::Publish, checkpoint)?;
    let publication = replacement.replace(&staging, target).await;
    match &publication {
        Ok(()) => {
            // The server already published: notify even if recording its receipt
            // fails locally. Retained recovery may remain Unknown in that case.
            (observer.published)();
            recovery::settle(record, true, checkpoint)?;
        }
        Err(AppError::RemoteRename {
            status_code: Some(_),
            ..
        }) => {
            recovery::settle(record, true, checkpoint)?;
        }
        Err(_) => {}
    }
    publication
}
