//! Shared create, mkdir and recursive-delete worker paths.
use super::*;

pub(crate) async fn mkdir(
    app: &AppHandle,
    session_id: &str,
    path: String,
    policy: impl Policy,
) -> AppResult<()> {
    admission::mutate(
        app,
        session_id,
        vec![path.clone()],
        native_save::runtime::MutationKind::Mkdir,
        policy,
        move |sftp, observed| async move { observed.request(sftp.create_dir(path)).await },
    )
    .await
}

pub(crate) async fn delete(
    app: &AppHandle,
    session_id: &str,
    path: String,
    policy: impl Policy,
) -> AppResult<()> {
    admission::mutate(
        app,
        session_id,
        vec![path.clone()],
        native_save::runtime::MutationKind::Delete,
        policy,
        move |sftp, observed| async move {
            remove_remote_entry_observed(&sftp, &path, Some(&observed)).await
        },
    )
    .await
}

pub(crate) async fn create_file(
    app: &AppHandle,
    session_id: &str,
    path: String,
    policy: impl Policy,
) -> AppResult<()> {
    admission::mutate(
        app,
        session_id,
        vec![path.clone()],
        native_save::runtime::MutationKind::Create,
        policy,
        move |sftp, observed| async move {
            let mut file = observed
                .request(sftp.open_with_flags(
                    &path,
                    OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::EXCLUDE,
                ))
                .await?;
            observed
                .close(async { file.shutdown().await.map_err(AppError::from) })
                .await
        },
    )
    .await
}
