use super::*;
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Serialize, Deserialize)]
struct ResumeCheckpoint {
    source: (u64, Option<i64>),
    partial: (u64, Option<i64>),
}

#[derive(Serialize, Deserialize)]
struct ParallelCheckpoint {
    source: (u64, Option<i64>),
    offset: u64,
}

pub(super) fn begin_window(
    app: &AppHandle,
    key: &str,
    source: (u64, Option<i64>),
    offset: u64,
) -> AppResult<()> {
    put(
        app,
        &key.replacen("transfer-file:", "transfer-parallel:", 1),
        serde_json::to_string(&ParallelCheckpoint { source, offset })?,
    )
}

pub(super) fn end_window(app: &AppHandle, key: &str) -> AppResult<()> {
    app.state::<AppState>().db.with(|conn| {
        conn.execute(
            "DELETE FROM settings WHERE key=?1",
            [key.replacen("transfer-file:", "transfer-parallel:", 1)],
        )?;
        Ok(())
    })
}

pub(super) async fn recover_window(
    app: &AppHandle,
    key: &str,
    source: (u64, Option<i64>),
    temp: &Endpoint,
    sftp: Option<&SftpSession>,
) -> AppResult<()> {
    let marker = get(
        app,
        &key.replacen("transfer-file:", "transfer-parallel:", 1),
    )?;
    let Some(marker) = marker else { return Ok(()) };
    let checkpoint: ParallelCheckpoint = serde_json::from_str(&marker)?;
    restore_window_prefix(checkpoint, source, temp, sftp).await?;
    end_window(app, key)
}

async fn restore_window_prefix(
    checkpoint: ParallelCheckpoint,
    source: (u64, Option<i64>),
    temp: &Endpoint,
    sftp: Option<&SftpSession>,
) -> AppResult<()> {
    if checkpoint.source != source || checkpoint.offset > source.0 {
        return Err(AppError::validation("sftp.resumeSourceChanged"));
    }
    let length = file_length(temp, sftp).await?.unwrap_or(0);
    if length < checkpoint.offset {
        return Err(AppError::validation("sftp.resumePrefixMismatch"));
    }
    if length > checkpoint.offset {
        // Discard sparse or partially acknowledged writes from the interrupted
        // window before any prefix can be trusted as resumable data.
        segments::resize(temp, sftp, checkpoint.offset).await?;
    }
    Ok(())
}

fn get(app: &AppHandle, key: &str) -> AppResult<Option<String>> {
    app.state::<AppState>().db.with(|conn| {
        Ok(conn
            .query_row("SELECT value FROM settings WHERE key=?1", [key], |r| {
                r.get(0)
            })
            .optional()?)
    })
}

fn put(app: &AppHandle, key: &str, value: String) -> AppResult<()> {
    app.state::<AppState>().db.with(|conn| {
        conn.execute("INSERT INTO settings(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
            rusqlite::params![key, value, crate::models::now_ms()])?;
        Ok(())
    })
}

pub(super) fn record(app: &AppHandle, id: &str, to: &Endpoint) -> AppResult<()> {
    put(
        app,
        &format!(
            "transfer-artifact:{id}:{:x}",
            Sha256::digest(to.path.as_bytes())
        ),
        serde_json::to_string(&to.path)?,
    )
}

pub(super) async fn checkpoint(
    app: &AppHandle,
    key: &str,
    source: (u64, Option<i64>),
    temp: &Endpoint,
    sftp: Option<&SftpSession>,
    submitted: std::ops::RangeInclusive<u64>,
) -> AppResult<()> {
    let partial = source_stamp(temp, sftp).await?;
    if submitted.contains(&partial.0) && partial.0 <= source.0 {
        put(
            app,
            &key.replacen("transfer-file:", "transfer-part:", 1),
            serde_json::to_string(&ResumeCheckpoint { source, partial })?,
        )?;
    } else {
        return Err(AppError::validation("sftp.resumePrefixMismatch"));
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn resume_offset(
    app: &AppHandle,
    key: &str,
    source: (u64, Option<i64>),
    temp: &Endpoint,
    sftp: Option<&SftpSession>,
    reader: &mut Reader,
    existing: u64,
    cancel: &AtomicBool,
) -> AppResult<()> {
    let saved = get(app, &key.replacen("transfer-file:", "transfer-part:", 1))?
        .and_then(|raw| serde_json::from_str::<ResumeCheckpoint>(&raw).ok());
    let unchanged = if let Some(saved) = saved {
        saved.source == source
            && source.1.is_some()
            && saved.partial.0 == existing
            && saved.partial.1.is_some()
            && saved.partial == source_stamp(temp, sftp).await?
    } else {
        false
    };
    verify_resume(reader, temp, sftp, existing, unchanged, cancel).await
}

async fn verify_resume(
    reader: &mut Reader,
    temp: &Endpoint,
    sftp: Option<&SftpSession>,
    existing: u64,
    unchanged: bool,
    cancel: &AtomicBool,
) -> AppResult<()> {
    if unchanged {
        // A cleanly closed staging file is our checkpoint. Check its boundaries
        // against the unchanged source instead of downloading gigabytes again.
        let head = existing.min(CHUNK as u64);
        verify_range(reader, temp, sftp, 0, head, Some(cancel)).await?;
        let offset = head.max(existing.saturating_sub(CHUNK as u64));
        verify_range(reader, temp, sftp, offset, existing - offset, Some(cancel)).await?;
    } else {
        // Crashes, legacy records and externally changed staging files retain
        // the complete byte-for-byte verification path.
        verify_prefix(reader, temp, sftp, existing, Some(cancel)).await?;
    }
    reader.seek(existing).await
}

fn recorded_paths(app: &AppHandle, id: &str) -> AppResult<Vec<String>> {
    app.state::<AppState>().db.with(|conn| {
        let mut query = conn.prepare("SELECT value FROM settings WHERE instr(key,?1)=1")?;
        let values = query.query_map([format!("transfer-artifact:{id}:")], |r| {
            r.get::<_, String>(0)
        })?;
        let mut paths = Vec::new();
        for raw in values {
            paths.push(serde_json::from_str(&raw?)?);
        }
        Ok(paths)
    })
}

async fn cleanup_file(
    app: &AppHandle,
    id: &str,
    to: &Endpoint,
    sftp: Option<&SftpSession>,
) -> AppResult<()> {
    if get(
        app,
        &format!(
            "transfer-file:{id}:{:x}",
            Sha256::digest(to.path.as_bytes())
        ),
    )?
    .is_none()
    {
        return Ok(());
    }
    let key = format!(
        "transfer-backup:{id}:{:x}",
        Sha256::digest(to.path.as_bytes())
    );
    cleanup_owned(id, to, sftp, backup_checkpoint(app, &key)?.as_ref()).await
}

pub(super) async fn cleanup_owned(
    id: &str,
    to: &Endpoint,
    sftp: Option<&SftpSession>,
    expected: Option<&BackupFingerprint>,
) -> AppResult<()> {
    let temp = staging_endpoint(to, id, "part");
    let backup = staging_endpoint(to, id, "backup");
    let cancel = AtomicBool::new(false);
    if file_length(&backup, sftp).await?.is_some() {
        let recovery = || AppError::BackupRecovery {
            backup: backup.path.clone(),
            destination: to.path.clone(),
        };
        let expected = expected.ok_or_else(recovery)?;
        if fingerprint_file(&backup, sftp, &cancel).await? != *expected {
            return Err(AppError::validation("sftp.resumePrefixMismatch"));
        }
        // Checking for a missing destination before renaming is not atomic.
        // Preserve the backup until it can be restored without overwriting a
        // destination created concurrently by another process or SFTP client.
        return Err(recovery());
    }
    if file_length(&temp, sftp).await?.is_some() {
        remove_endpoint(&temp, sftp).await?;
    }
    Ok(())
}

/// No source or completed destination is removed. Keep the journal on error so
/// a disconnected host can be reconnected and cleanup can be retried.
pub(super) async fn cleanup(
    app: &AppHandle,
    row: &durable::DurableTransfer,
    to: &Endpoint,
) -> AppResult<()> {
    let targets = recorded_paths(app, &row.id)?;
    // A completed job with no checkpoint predates staging and needs no network.
    if row.status == "done" && targets.is_empty() {
        return Ok(());
    }
    let sftp = match &to.session {
        Some(id) => Some(session(app, id).await?),
        None => None,
    };
    let result = async {
        for path in &targets {
            cleanup_file(app, &row.id, &to.child(path.clone()), sftp.as_ref()).await?;
        }
        // Support jobs created before explicit artifact records. Only inspect
        // their destination tree and remove names matching a saved file key.
        if targets.is_empty() {
            cleanup_file(app, &row.id, to, sftp.as_ref()).await?;
        }
        let directory = match sftp.as_ref() {
            Some(s) => match s.symlink_metadata(&to.path).await {
                Ok(m) => m.is_dir() && !m.is_symlink(),
                Err(russh_sftp::client::error::Error::Status(st))
                    if st.status_code == StatusCode::NoSuchFile =>
                {
                    false
                }
                Err(e) => return Err(map_sftp(e)),
            },
            None => match tokio::fs::symlink_metadata(&to.path).await {
                Ok(m) => m.is_dir() && !local_metadata_is_link(&m),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
                Err(e) => return Err(e.into()),
            },
        };
        if targets.is_empty() && directory {
            cleanup_legacy_tree(app, &row.id, to, sftp.as_ref()).await?;
        }
        Ok(())
    }
    .await;
    if let Some(sftp) = sftp {
        let _ = tokio::time::timeout(std::time::Duration::from_secs(5), sftp.close()).await;
    }
    result
}

async fn cleanup_legacy_tree(
    app: &AppHandle,
    id: &str,
    root: &Endpoint,
    sftp: Option<&SftpSession>,
) -> AppResult<()> {
    let prefixes: Vec<String> = app.state::<AppState>().db.with(|conn| {
        let mut query = conn.prepare("SELECT key FROM settings WHERE instr(key,?1)=1")?;
        let keys = query.query_map([format!("transfer-file:{id}:")], |r| r.get::<_, String>(0))?;
        let mut result = Vec::new();
        for key in keys {
            let key = key?;
            if let Some(digest) = key
                .rsplit(':')
                .next()
                .filter(|v| v.len() == 64 && v.bytes().all(|b| b.is_ascii_hexdigit()))
            {
                result.push(format!(".tunnelde-{id}-{}", &digest[..16]));
            }
        }
        Ok(result)
    })?;
    let mut pending = vec![root.clone()];
    while let Some(folder) = pending.pop() {
        for path in children(&folder, sftp).await? {
            let entry = folder.child(path);
            match is_dir(&entry, sftp).await {
                Ok(true) => pending.push(entry),
                Ok(false) => {
                    let name = file_name_of(&entry.path);
                    if prefixes
                        .iter()
                        .any(|prefix| name == format!("{prefix}.part"))
                    {
                        remove_endpoint(&entry, sftp).await?;
                    } else if prefixes
                        .iter()
                        .any(|prefix| name == format!("{prefix}.backup"))
                    {
                        // Legacy directory records do not identify the original
                        // filename. Preserve its backup and the recovery record.
                        return Err(AppError::validation("sftp.backupRecoveryRequired"));
                    }
                }
                Err(AppError::Validation(message)) if message == "sftp.symlinkUnsupported" => {}
                Err(error) => return Err(error),
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn interrupted_parallel_windows_trim_only_uncommitted_bytes_and_reject_changed_sources() {
        let root = std::env::temp_dir().join(format!("tunnelde-window-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir(&root).await.unwrap();
        let target = Endpoint {
            session: None,
            path: display_path(&root.join("owned.part")),
        };
        tokio::fs::write(&target.path, b"safeSPARSE UNCOMMITTED DATA")
            .await
            .unwrap();
        let source = (1024, Some(123));
        restore_window_prefix(
            ParallelCheckpoint { source, offset: 4 },
            source,
            &target,
            None,
        )
        .await
        .unwrap();
        assert_eq!(tokio::fs::read(&target.path).await.unwrap(), b"safe");
        assert!(restore_window_prefix(
            ParallelCheckpoint { source, offset: 4 },
            (1024, Some(124)),
            &target,
            None
        )
        .await
        .is_err());
        assert!(restore_window_prefix(
            ParallelCheckpoint { source, offset: 5 },
            source,
            &target,
            None
        )
        .await
        .is_err());
        assert_eq!(tokio::fs::read(&target.path).await.unwrap(), b"safe");
        tokio::fs::remove_dir_all(root).await.unwrap();
    }

    #[tokio::test]
    async fn cleanup_removes_partial_files_and_preserves_backups_for_recovery() {
        let root = std::env::temp_dir().join(format!("tunnelde-cleanup-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir(&root).await.unwrap();
        let target = Endpoint {
            session: None,
            path: display_path(&root.join("target")),
        };
        let part = staging_endpoint(&target, "job", "part");
        let backup = staging_endpoint(&target, "job", "backup");
        let unrelated = target.child(display_path(&root.join(".tunnelde-another.part")));
        tokio::fs::write(&target.path, b"user data").await.unwrap();
        tokio::fs::write(&part.path, b"partial").await.unwrap();
        tokio::fs::write(&unrelated.path, b"other job")
            .await
            .unwrap();
        cleanup_owned("job", &target, None, None).await.unwrap();
        assert!(!Path::new(&part.path).exists());
        assert_eq!(tokio::fs::read(&target.path).await.unwrap(), b"user data");
        assert!(Path::new(&unrelated.path).exists());

        let expected = fingerprint_file(&target, None, &AtomicBool::new(false))
            .await
            .unwrap();
        tokio::fs::rename(&target.path, &backup.path).await.unwrap();
        tokio::fs::write(&part.path, b"partial").await.unwrap();
        let error = cleanup_owned("job", &target, None, Some(&expected))
            .await
            .unwrap_err();
        assert!(matches!(
            error,
            AppError::BackupRecovery { ref backup, ref destination }
                if backup == &staging_endpoint(&target, "job", "backup").path
                    && destination == &target.path
        ));
        assert!(!Path::new(&target.path).exists());
        assert_eq!(tokio::fs::read(&backup.path).await.unwrap(), b"user data");
        assert_eq!(tokio::fs::read(&part.path).await.unwrap(), b"partial");

        tokio::fs::write(&target.path, b"new independent data")
            .await
            .unwrap();
        tokio::fs::write(&part.path, b"partial").await.unwrap();
        assert_eq!(
            cleanup_owned("job", &target, None, Some(&expected))
                .await
                .unwrap_err()
                .to_string(),
            "sftp.backupRecoveryRequired"
        );
        assert_eq!(tokio::fs::read(&backup.path).await.unwrap(), b"user data");
        assert_eq!(
            tokio::fs::read(&target.path).await.unwrap(),
            b"new independent data"
        );
        assert_eq!(tokio::fs::read(&part.path).await.unwrap(), b"partial");
        tokio::fs::remove_file(&target.path).await.unwrap();
        tokio::fs::rename(&backup.path, &target.path).await.unwrap();

        tokio::fs::write(&backup.path, b"unrecognized data")
            .await
            .unwrap();
        tokio::fs::write(&part.path, b"partial").await.unwrap();
        assert!(cleanup_owned("job", &target, None, Some(&expected))
            .await
            .is_err());
        assert!(Path::new(&backup.path).exists());
        assert!(Path::new(&part.path).exists());
        assert_eq!(tokio::fs::read(&target.path).await.unwrap(), b"user data");
        tokio::fs::remove_dir_all(root).await.unwrap();
    }

    #[tokio::test]
    async fn checkpoint_resume_reads_boundaries_and_positions_at_the_real_offset() {
        let root = std::env::temp_dir().join(format!("tunnelde-resume-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir(&root).await.unwrap();
        let source = Endpoint {
            session: None,
            path: display_path(&root.join("source")),
        };
        let temp = source.child(display_path(&root.join("partial")));
        let data: Vec<u8> = (0..CHUNK * 5 + 13).map(|i| (i % 251) as u8).collect();
        tokio::fs::write(&source.path, &data).await.unwrap();
        let existing = (CHUNK * 4 + 3) as u64;
        tokio::fs::write(&temp.path, &data[..existing as usize])
            .await
            .unwrap();
        let mut reader = open_reader(&source, None).await.unwrap();
        let cancel = AtomicBool::new(false);
        verify_resume(&mut reader, &temp, None, existing, true, &cancel)
            .await
            .unwrap();
        let mut next = [0; 10];
        reader.read(&mut next).await.unwrap();
        assert_eq!(next, data[existing as usize..existing as usize + 10]);
        let mut changed = data[..existing as usize].to_vec();
        changed[CHUNK * 2] ^= 1;
        tokio::fs::write(&temp.path, changed).await.unwrap();
        assert!(
            verify_resume(&mut reader, &temp, None, existing, false, &cancel)
                .await
                .is_err()
        );
        reader.finish().await.unwrap();
        tokio::fs::remove_dir_all(root).await.unwrap();
    }

    #[tokio::test]
    async fn pending_socket_operations_can_be_cancelled() {
        let flag = Arc::new(AtomicBool::new(false));
        let worker_flag = flag.clone();
        let task = tokio::spawn(async move {
            interruptible(Some(&worker_flag), std::future::pending::<AppResult<()>>()).await
        });
        flag.store(true, Ordering::SeqCst);
        let result = tokio::time::timeout(std::time::Duration::from_millis(250), task)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(result.unwrap_err().to_string(), CANCELLED);
    }
}
