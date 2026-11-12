//! Include private staging and backup paths in existing native recovery fences.
use super::*;

pub(super) async fn writable(
    app: &AppHandle,
    id: &str,
    to: &Endpoint,
    sftp: Option<&SftpSession>,
    record: Option<&ArtifactRecord>,
) -> AppResult<()> {
    let (Some(session_id), Some(sftp)) = (to.session.as_deref(), sftp) else {
        return Ok(());
    };
    let mut paths = vec![
        to.path.clone(),
        part_from_record(to, id, record)?.path,
        staging_endpoint(to, id, "backup").path,
    ];
    if let Some(staging) = remote_staging(record) {
        paths.push(staging_directory(to, id, staging)?.path);
    }
    if let Some(ArtifactRecord::Current {
        publication: Some(Publication {
            successor: Some(generation),
        }),
        ..
    }) = record
    {
        paths.push(publication_successor(to, id, generation, record)?.path);
    }
    let paths: Vec<_> = paths.iter().map(String::as_str).collect();
    admission::writable(app, session_id, sftp, &paths).await
}
