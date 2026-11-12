//! Server-side rename and merge; each mutation rechecks its owner.
use super::*;

pub(crate) async fn rename(
    app: &AppHandle,
    session_id: &str,
    from: String,
    to: String,
    overwrite: bool,
    policy: impl Policy,
) -> AppResult<()> {
    let connection = app.clone();
    let id = session_id.to_owned();
    let original_from = from.clone();
    let original_to = to.clone();
    admission::mutate(
        app,
        session_id,
        vec![from.clone(), to.clone()],
        native_save::runtime::MutationKind::Rename,
        policy,
        move |sftp, observed| async move {
            check_remote_destination(&sftp, &from, &to, overwrite).await?;
            if overwrite && remote_exists(&sftp, &to).await? {
                // Merge real directories using only server-side renames. Resolving
                // roots once also permits a user's parent directory symlink.
                if sftp
                    .symlink_metadata(&from)
                    .await
                    .map_err(map_sftp)?
                    .is_dir()
                    && sftp.symlink_metadata(&to).await.map_err(map_sftp)?.is_dir()
                {
                    let source = sftp.canonicalize(&from).await.map_err(map_sftp)?;
                    let target = sftp.canonicalize(&to).await.map_err(map_sftp)?;
                    let plan = remote_merge::Plan::prepare(&sftp, &source, &target).await?;
                    let replacement = if plan.needs_replacement {
                        Some(remote_commit::Replacement::connect(&connection, &id).await?)
                    } else {
                        None
                    };
                    return plan
                        .apply_guarded(&sftp, replacement.as_ref(), Some(&observed))
                        .await;
                }
                let replacement = remote_commit::Replacement::connect(&connection, &id).await?;
                return observed.opaque(replacement.commit(&from, &to)).await;
            }
            observed
                .request_with(sftp.rename(&from, &to), |error| {
                    super::super::rename::failure(&from, &to, error)
                })
                .await
        },
    )
    .await
    .map_err(|error| super::super::rename::context(&original_from, &original_to, error))
}
