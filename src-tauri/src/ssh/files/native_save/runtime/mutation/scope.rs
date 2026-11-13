//! Captured lexical and canonical paths, bounded independently of network speed.
use super::*;

pub(super) async fn resolve(
    destination: &SessionIdentity,
    sftp: &SftpSession,
    paths: &[String],
) -> AppResult<Scope> {
    if paths.is_empty() || paths.len() > 16 {
        return Err(AppError::validation("editor.nativeBusy"));
    }
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
    let mut spellings = Vec::new();
    for path in paths {
        spellings.push(path.clone());
        spellings.push(
            tokio::time::timeout_at(deadline, admission::resolve(sftp, path))
                .await
                .map_err(|_| AppError::validation("editor.nativeReconnect"))??,
        );
    }
    let windows = spellings.iter().any(|path| {
        crate::services::files::admission::Path::new(
            path,
            crate::services::files::admission::Platform::Windows,
        )
        .is_some()
    });
    Ok(Scope {
        destination: destination.clone(),
        platform: if windows { "windows" } else { "posix" }.into(),
        paths: spellings,
    })
}
