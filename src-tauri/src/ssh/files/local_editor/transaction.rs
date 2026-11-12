//! Local staging and atomic publication, separate from worker admission.
use super::*;
use crate::services::files::operations::Cancellation;

pub(super) fn save(
    app: Option<&AppHandle>,
    requested: &str,
    content: &str,
    baseline: Option<&str>,
    policy: &impl policy::Policy,
    job: &Cancellation,
    mut hook: impl FnMut(&str, &Record) -> AppResult<()>,
) -> AppResult<()> {
    job.check()?;
    policy.authorize()?;
    let requested = Path::new(requested);
    let target = std::fs::canonicalize(requested)?;
    let lock = lock_for(&target);
    let _guard = lock.lock().unwrap();
    job.check()?;
    policy.authorize()?;
    // Require write permission to the existing file, not merely its parent.
    drop(native::open_regular(&target, true)?);
    let mut source = native::open_regular(&target, false)?;
    let source_identity = native::identity(&source)?;
    let metadata = source.metadata()?;
    if metadata.permissions().readonly() {
        return Err(AppError::validation("editor.readOnlyFile"));
    }
    let original = decode_text(native::read_bounded(&mut source, MAX_TEXT)?)?;
    let baseline = baseline.unwrap_or(&original.content);
    policy.check(&target, &original.content)?;
    job.check()?;
    if original.content == content {
        policy.admit(job)?;
        return Ok(());
    }
    if original.content != baseline {
        return Err(AppError::validation("editor.localFileChanged"));
    }
    let id = format!("local-{}", uuid::Uuid::new_v4());
    let directory = target
        .parent()
        .ok_or_else(|| AppError::validation("sftp.invalidName"))?
        .join(format!(".tunnelde-save-{id}"));
    let mut record = Record {
        id,
        path: target.clone(),
        directory,
        directory_identity: None,
        staging_identity: None,
        token: uuid::Uuid::new_v4().to_string(),
        removing_marker: false,
        updated_at: crate::models::now_ms(),
        error: None,
    };
    let held = Reservation::new(&record.id, false)?;
    let checkpoint = |r: &Record| app.map_or(Ok(()), |app| persist(app, r));
    checkpoint(&record)?;
    let result = (|| {
        native::private_directory(&record.directory)?;
        record.directory_identity = Some(native::directory_identity(&record.directory)?);
        checkpoint(&record)?;
        let mut marker = File::options()
            .write(true)
            .create_new(true)
            .open(record.directory.join("owner"))?;
        marker.write_all(record.token.as_bytes())?;
        marker.sync_all()?;
        drop(marker);
        let staging = record.directory.join("content");
        native::copy_original(&mut source, &target, &staging, MAX_TEXT)?;
        let stage = native::open_regular(&staging, false)?;
        record.staging_identity = Some(native::identity(&stage)?);
        drop(stage);
        checkpoint(&record)?;
        hook("copied", &record)?;
        let mut stage = native::open_regular(&staging, true)?;
        if Some(native::identity(&stage)?) != record.staging_identity {
            return Err(AppError::validation("editor.cleanupUnrecognized"));
        }
        native::write_staging(&mut stage, content.as_bytes(), MAX_TEXT)?;
        native::preserve_metadata(&source, &stage)?;
        drop(stage);
        native::preserve_security(&target, &staging)?;
        native::verify_security(&target, &staging)?;
        hook("staged", &record)?;
        let mut current = native::open_regular(&target, false)?;
        if native::identity(&current)? != source_identity
            || !native::same_metadata(&metadata, &source.metadata()?)
            || decode_text(native::read_bounded(&mut source, MAX_TEXT)?)?.content != baseline
            || decode_text(native::read_bounded(&mut current, MAX_TEXT)?)?.content != baseline
            || std::fs::canonicalize(requested)? != target
        {
            return Err(AppError::validation("editor.localFileChanged"));
        }
        hook("verified", &record)?;
        policy.check(&target, &original.content)?;
        policy.admit(job)?;
        native::publish(&staging, &target, record.staging_identity.as_ref().unwrap())?;
        hook("published", &record)?;
        Ok(())
    })();
    drop(source);
    match cleanup(&mut record, checkpoint) {
        Ok(()) => {
            if let Some(app) = app {
                forget(app, &record)?;
            }
        }
        Err(error) => {
            tracing::warn!(%error, path = %record.directory.display(), "Local editor staging cleanup deferred");
            record.error = Some(error.to_string());
            record.updated_at = crate::models::now_ms();
            checkpoint(&record)?;
        }
    }
    drop(held);
    if let Some(app) = app {
        let _ = app.emit(EVENT, ());
    }
    result
}
