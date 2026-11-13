use super::super::{client::Client, journal::Owner, runtime::errors, transport::ssh::Ssh};
use super::{consent, preparation::Prepared, remote::Remote};
use crate::{
    error::{AppError, AppResult},
    state::AppState,
};
use std::sync::{Arc, OnceLock};
use tauri::{AppHandle, Emitter, Manager};

pub(in crate::ssh::files) async fn install(
    app: AppHandle,
    session: String,
    path: String,
) -> AppResult<bool> {
    let result = perform(app, session, path).await;
    if let Err(error) = &result {
        tracing::warn!(target: "files.setup", reason = %error,
            action = "inspect_recovery_and_logs", "Recoverable save setup did not complete");
    }
    result
}

async fn perform(app: AppHandle, session: String, path: String) -> AppResult<bool> {
    static WORKERS: OnceLock<Arc<tokio::sync::Semaphore>> = OnceLock::new();
    let permit = WORKERS
        .get_or_init(|| Arc::new(tokio::sync::Semaphore::new(1)))
        .clone()
        .try_acquire_owned()
        .map_err(|_| AppError::validation("editor.nativeBusy"))?;
    // Before consent only read-only probes on the selected authenticated connection.
    let prepared = Prepared::capture(Remote::capture(app.clone(), session)?, &path).await?;
    let state = app.state::<AppState>();
    if state.native_saves.ready_setup(&prepared.plan).await? {
        return Ok(true);
    }
    if !consent::ask(&prepared).await? {
        return Ok(false);
    }
    prepared.verify_scope().await?;
    let http = crate::network::http_client(&app, "marketplace")?;
    let package = prepared.package.download(&http).await?;
    prepared.verify_scope().await?;
    let service = state
        .native_saves
        .initialize()
        .await
        .map_err(errors::app_journal)?;
    let owner = Owner {
        id: uuid::Uuid::new_v4().to_string(),
        generation: uuid::Uuid::new_v4().to_string(),
    };
    let reservation = service
        .reserve_setup(owner, prepared.plan.clone())
        .await
        .map_err(errors::app_journal)?;
    // Owned worker survives a dropped IPC receiver. The journal owns any unknown
    // effects; neither disconnect nor cancellation recursively cleans the paths.
    tauri::async_runtime::spawn(async move {
        let _permit = permit;
        let worker = service.observe_legacy_worker(&reservation.id);
        let result = async {
            prepared.verify_scope().await?;
            let dispatched = service
                .dispatch_setup(&reservation)
                .await
                .map_err(errors::app_journal)?;
            let _ = app.emit("editor://cleanup-changed", ());
            prepared.verify()?;
            prepared
                .remote
                .install(&prepared, &dispatched, &package)
                .await?;
            let platform = prepared
                .plan
                .package
                .platform()
                .ok_or_else(|| AppError::validation("editor.nativePlatformUnsupported"))?;
            let transport = Ssh::selected(
                app.clone(),
                prepared.remote.session.clone(),
                prepared.plan.destination.clone(),
                platform,
                &prepared.plan.selection.executable,
                &prepared.plan.selection.directory,
                prepared.plan.context.scope.clone(),
            )
            .map_err(errors::app_remote)?;
            prepared.remote.verify()?;
            let client = Client::initialize(transport, prepared.plan.context.clone(), platform)
                .await
                .map_err(errors::app_remote)?;
            prepared.verify_scope().await?;
            service
                .complete_setup(dispatched, client.authority().clone())
                .await
                .map_err(errors::app_journal)?;
            Ok(true)
        }
        .await;
        drop(worker);
        let _ = app.emit("editor://cleanup-changed", ());
        result
    })
    .await
    .map_err(|_| AppError::validation("editor.remoteOutcomeUnknown"))?
}
