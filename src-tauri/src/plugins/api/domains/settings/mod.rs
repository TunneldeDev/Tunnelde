use crate::plugins::api::{authorize, encode, field, transport::operation::Operation, HostContext};
use crate::{
    error::{AppError, AppResult},
    state::AppState,
};
use serde_json::Value;
use std::sync::{Arc, OnceLock};
use tauri::Manager;
use tokio::sync::Semaphore;
mod preferences;
mod profiles;

pub(in crate::plugins::api) async fn dispatch(
    context: &HostContext,
    method: &str,
    params: Value,
) -> AppResult<Value> {
    if method == "fonts.catalogue" {
        if params.as_object().is_none_or(|fields| !fields.is_empty()) {
            return Err(AppError::validation("plugin.api.invalid:params"));
        }
        let policy = crate::plugins::frontend::native::CallPolicy::StagedData;
        crate::platform::panel_windows::plugin_views::origin::check(policy)?;
        authorize(context, &["settings.read"])?;
        let result = crate::fonts::catalogue(&context.app, false).await?;
        authorize(context, &["settings.read"])?;
        crate::platform::panel_windows::plugin_views::origin::check(policy)?;
        return encode(result);
    }
    if method.starts_with("profiles.") {
        return profiles::dispatch(context, method, params).await;
    }
    if method.starts_with("preferences.") {
        return preferences::dispatch(context, method, params).await;
    }
    let app = &context.app;
    let state = app.state::<AppState>();
    match method {
        "settings.get" => {
            let staged = crate::plugins::frontend::native::CallPolicy::StagedData;
            crate::platform::panel_windows::plugin_views::origin::check(staged)?;
            let value = encode(crate::services::settings::read(&state));
            crate::platform::panel_windows::plugin_views::origin::check(staged)?;
            value
        }
        "settings.update" => {
            let patch: Value = field(&params, "patch")?;
            if !patch.is_object() {
                return Err(AppError::validation("plugin.api.invalid:patch"));
            }
            if patch.get("uiProviders").is_some() {
                return Err(AppError::validation(
                    "plugin.frontend.userSelectionRequired",
                ));
            }
            // Persisting file contents requires a local user choice, including
            // for legacy settings writers outside the versioned allowlist.
            if patch.get("editorDraftRecovery").is_some() {
                return Err(AppError::validation("editor.recoveryConsentRequired"));
            }
            let worker = context.clone();
            let origin = crate::platform::panel_windows::plugin_views::origin::current();
            static CAPACITY: OnceLock<Arc<Semaphore>> = OnceLock::new();
            let operation =
                Operation::admit(CAPACITY.get_or_init(|| Arc::new(Semaphore::new(4))).clone())?;
            let ticket = operation.ticket();
            crate::services::settings::write(app, move |writer| {
                let state = worker.app.state::<AppState>();
                ticket.check()?;
                authorize(&worker, &["settings.write"])?;
                let prepared = writer.prepare_update(patch)?;
                let lease = crate::plugins::security::Lease {
                    id: worker.id.clone(),
                    fingerprint: worker.fingerprint.clone(),
                    permissions: worker.permissions.clone(),
                    generation: worker.generation,
                };
                // Waiting for a concurrent commit is an authorization boundary too.
                let cancellation = prepared.cancellation();
                let prepared = std::cell::RefCell::new(prepared);
                let authority = origin
                    .as_ref()
                    .map(|origin| origin as &dyn crate::services::operations::Authority);
                state
                    .plugins
                    .security
                    .with_authorized_fenced_database_then(
                        &state.db,
                        &lease,
                        &["settings.write"],
                        || {
                            ticket.check()?;
                            cancellation.check()
                        },
                        authority,
                        |conn| {
                            ticket.check()?;
                            prepared.borrow().persist_on(conn)
                        },
                        |revision| {
                            ticket.commit()?;
                            prepared.borrow_mut().committed_revision(revision);
                            Ok(())
                        },
                    )?;
                encode(prepared.into_inner().finish())
            })
            .await
        }
        _ => Err(AppError::validation("plugin.api.unknownMethod")),
    }
}
