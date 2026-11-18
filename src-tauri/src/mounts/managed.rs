//! Managed-rule file opening retains the same containment and mount identity
//! checks as legacy plugin reveals, with authority rechecked at OS launch.
use super::*;
use crate::services::mounts::runtime::{Authority, OWNER};

pub(crate) async fn open_managed(
    app: AppHandle,
    id: String,
    session: String,
    path: Option<String>,
    reveal: bool,
    authority: Authority,
) -> AppResult<()> {
    let state = app.state::<crate::state::AppState>();
    let record = state
        .mounts
        .live_owned_mount(OWNER, 0, &id, &session)
        .await?;
    let relative = mounted_relative_path(
        &record.remote_path,
        path.as_deref().unwrap_or(&record.remote_path),
    )?;
    let target = resolve_mounted_target(PathBuf::from(&record.mount_point), relative).await?;
    #[cfg(target_os = "linux")]
    {
        let table = tokio::fs::read_to_string("/proc/self/mountinfo").await?;
        if nested_mount_on_path(&table, Path::new(&record.mount_point), &target) {
            return Err(AppError::validation("mounts.remotePath.outsideMount"));
        }
    }
    state
        .mounts
        .live_owned_mount(OWNER, 0, &id, &session)
        .await?;
    authority.check(&app)?;
    let runtime = tokio::runtime::Handle::current();
    cancellable_open(move |allowed| {
        use std::sync::atomic::Ordering;
        if !allowed.load(Ordering::Acquire) {
            return Err(AppError::validation("mounts.operations.cancelled"));
        }
        if !target.exists() {
            return Err(AppError::NotFound("path.notFound".into()));
        }
        runtime.block_on(
            app.state::<crate::state::AppState>()
                .mounts
                .live_owned_mount(OWNER, 0, &id, &session),
        )?;
        authority.check(&app)?;
        if !allowed.load(Ordering::Acquire) {
            return Err(AppError::validation("mounts.operations.cancelled"));
        }
        authority.commit(&app, || {
            if !allowed.load(Ordering::Acquire) {
                return Err(AppError::validation("mounts.operations.cancelled"));
            }
            if reveal {
                tauri_plugin_opener::reveal_item_in_dir(target)
                    .map_err(|e| AppError::internal(e.to_string()))
            } else {
                app.opener()
                    .open_path(target.to_string_lossy().into_owned(), None::<&str>)
                    .map_err(|e| AppError::internal(e.to_string()))
            }
        })
    })
    .await
}
