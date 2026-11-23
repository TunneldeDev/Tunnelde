use super::*;
use crate::{
    services::{
        credentials,
        operations::{Budget, Errors},
    },
    state::AppState,
};
use std::sync::LazyLock;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::DialogExt;
use zeroize::Zeroizing;

static WORKERS: LazyLock<Budget> = LazyLock::new(|| {
    Budget::new(
        2,
        Errors {
            domain: "hostTransfer",
            busy: "hostTransfer.busy",
            cancelled: "hostTransfer.cancelled",
            failed: "hostTransfer.failed",
        },
    )
});
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FilePreview {
    token: String,
    encrypted: bool,
    has_credentials: bool,
    preview: Option<Preview>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImportResult {
    pub hosts: Vec<Host>,
    pub credential_errors: Vec<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FileRequest {
    token: String,
    revision: String,
    selected: Vec<String>,
    #[serde(default)]
    copies: bool,
    #[serde(default)]
    mount_points: HashMap<String, String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ExportOptions {
    include_credentials: bool,
    encrypt: bool,
    password: Option<String>,
}

impl ExportOptions {
    fn validate(&self) -> AppResult<()> {
        if self.include_credentials && !self.encrypt {
            return Err(AppError::validation("hostTransfer.encryptionRequired"));
        }
        if self.encrypt
            && self
                .password
                .as_ref()
                .is_none_or(|p| p.is_empty() || p.len() > 4096)
        {
            return Err(AppError::validation("hostTransfer.passwordRequired"));
        }
        Ok(())
    }
}
#[tauri::command]
pub(crate) fn hosts_export_password() -> String {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    use rand::RngExt;
    URL_SAFE_NO_PAD.encode(rand::rng().random::<[u8; 24]>())
}
fn preview_entry(
    state: &AppState,
    token: String,
    entry: &runtime::Entry,
) -> AppResult<FilePreview> {
    Ok(FilePreview {
        token,
        encrypted: entry.envelope.is_some(),
        has_credentials: entry.payload.as_ref().is_some_and(|p| p.has_credentials()),
        preview: entry
            .payload
            .as_ref()
            .map(|p| state.db.with(|conn| preview_at(conn, p.document.clone())))
            .transpose()?,
    })
}
#[tauri::command]
pub(crate) async fn hosts_file_import(app: AppHandle) -> AppResult<Option<FilePreview>> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .add_filter("Tunnelde hosts", &["json"])
        .pick_file(move |path| {
            let _ = tx.send(path);
        });
    let Some(path) = rx.await.map_err(|_| invalid())? else {
        return Ok(None);
    };
    WORKERS
        .blocking(move |job| {
            let bytes = crate::settings_profiles::files::read_bytes(
                std::path::Path::new(&path.to_string()),
                crypto::FILE_LIMIT,
            )
            .map_err(io_error)?;
            let bytes = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&bytes);
            // A plain document uses the original strict, credential-free schema.
            let entry = if let Ok(document) = serde_json::from_slice::<Document>(bytes) {
                validate_plain(&document)?;
                runtime::Entry::new(None, Some(portable::Portable::configuration(document)))
            } else {
                runtime::Entry::new(Some(crypto::parse(bytes)?), None)
            };
            let state = app.state::<AppState>();
            // Build a preview before retaining a context so invalid input cannot leak slots.
            let mut result = preview_entry(&state, String::new(), &entry)?;
            job.commit()?;
            let token = state.host_imports.insert(entry)?;
            result.token = token.clone();
            // Idle contexts expire even if the window is abandoned without a release RPC.
            let expiring_app = app.clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(60)).await;
                    let app = expiring_app.clone();
                    let id = token.clone();
                    if !tauri::async_runtime::spawn_blocking(move || {
                        app.state::<AppState>().host_imports.prune(&id)
                    })
                    .await
                    .unwrap_or(false)
                    {
                        break;
                    }
                }
            });
            Ok(Some(result))
        })
        .await
}
#[tauri::command]
pub(crate) async fn hosts_file_unlock(
    app: AppHandle,
    token: String,
    password: String,
) -> AppResult<FilePreview> {
    let password = Zeroizing::new(password);
    WORKERS
        .blocking(move |job| {
            let state = app.state::<AppState>();
            state.host_imports.with(&token, |entry| {
                if entry.payload.is_none() {
                    let bytes =
                        crypto::decrypt(entry.envelope.as_ref().ok_or_else(invalid)?, &password)?;
                    let payload: portable::Portable =
                        serde_json::from_slice(&bytes).map_err(|_| invalid())?;
                    payload.validate()?;
                    job.commit()?;
                    entry.payload = Some(payload);
                }
                preview_entry(&state, token.clone(), entry)
            })
        })
        .await
}
#[tauri::command]
pub(crate) async fn hosts_file_preview(app: AppHandle, token: String) -> AppResult<FilePreview> {
    WORKERS
        .blocking(move |_| {
            let state = app.state::<AppState>();
            state
                .host_imports
                .with(&token, |entry| preview_entry(&state, token.clone(), entry))
        })
        .await
}
#[tauri::command]
pub(crate) async fn hosts_file_release(app: AppHandle, token: String) {
    let _ = tauri::async_runtime::spawn_blocking(move || {
        app.state::<AppState>().host_imports.remove(&token)
    })
    .await;
}
fn save_pending(state: &AppState, entry: &mut runtime::Entry) -> Vec<String> {
    let mut errors = vec![];
    entry.pending.retain(|write| {
        if write.save(state).is_err() {
            errors.push(write.label.clone());
            true
        } else {
            false
        }
    });
    errors
}
#[tauri::command]
pub(crate) async fn hosts_file_retry_credentials(
    app: AppHandle,
    token: String,
) -> AppResult<ImportResult> {
    credentials::checked(move |job| {
        let state = app.state::<AppState>();
        let result = state.host_imports.with(&token, |entry| {
            if entry.result.is_none() {
                return Err(invalid());
            }
            job.commit()?;
            let errors = save_pending(&state, entry);
            let result = entry.result.as_mut().ok_or_else(invalid)?;
            result.credential_errors = errors;
            Ok(result.clone())
        });
        credentials::schedule_cleanup(&app);
        result
    })
    .await
}
#[tauri::command]
pub(crate) async fn hosts_file_apply(
    app: AppHandle,
    request: FileRequest,
) -> AppResult<ImportResult> {
    // Keep settings and all dependency remapping serialized with other imports.
    let locked_app = app.clone();
    let state = locked_app.state::<AppState>();
    let _commit = state.settings_commit.lock().await;
    credentials::checked(move |job| {
        let state = app.state::<AppState>();
        let token = request.token.clone();
        let result = state.host_imports.with(&token, |entry| {
            // Retrying a lost response is idempotent for this context.
            if let Some(result) = &entry.result {
                return Ok(result.clone());
            }
            let payload = entry.payload.as_ref().ok_or_else(invalid)?;
            let (applied, pending) = commit_import(
                &state.db,
                state.storage.dir(crate::storage::layout::Category::Keys),
                payload,
                request,
                || job.commit(),
            )?;
            entry.pending = pending;
            entry.result = Some(ImportResult {
                hosts: applied.hosts.clone(),
                credential_errors: vec![],
            });
            let errors = save_pending(&state, entry);
            if let Some(result) = entry.result.as_mut() {
                result.credential_errors = errors;
            }
            entry.payload = entry
                .payload
                .take()
                .map(|p| portable::Portable::configuration(p.document));
            entry.envelope = None;
            // Do not turn a committed import into a generic failure if publication fails.
            let _ = publish(&app, &state, &applied.hosts);
            Ok(entry.result.as_ref().ok_or_else(invalid)?.clone())
        });
        credentials::schedule_cleanup(&app);
        result
    })
    .await
}

// Legacy config-only native commands and plugin equivalents retain their strict format.
#[tauri::command]
pub(crate) fn hosts_import_preview(app: AppHandle, document: Document) -> AppResult<Preview> {
    app.state::<AppState>()
        .db
        .with(|conn| preview_at(conn, document))
}
#[tauri::command]
pub(crate) async fn hosts_import_apply(
    app: AppHandle,
    request: ImportRequest,
) -> AppResult<Vec<Host>> {
    let state = app.state::<AppState>();
    let _commit = state.settings_commit.lock().await;
    let imported = state.db.with(|conn| apply_at(conn, request))?;
    publish(&app, &state, &imported)?;
    Ok(imported)
}
#[tauri::command]
pub(crate) async fn hosts_file_export(
    app: AppHandle,
    ids: Vec<String>,
    options: ExportOptions,
) -> AppResult<Option<String>> {
    // Validate BEFORE showing a save dialog or reading any credential.
    options.validate()?;
    let password = Zeroizing::new(options.password.unwrap_or_default());
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .add_filter("Tunnelde hosts", &["json"])
        .set_file_name("tunnelde-hosts.json")
        .save_file(move |path| {
            let _ = tx.send(path);
        });
    let Some(path) = rx.await.map_err(|_| invalid())? else {
        return Ok(None);
    };
    let encrypt = options.encrypt;
    WORKERS
        .asynchronous(move |job| async move {
            let inspecting = job.clone();
            let bytes = credentials::inspect(move || {
                inspecting.check()?;
                let state = app.state::<AppState>();
                let (document, expected_revision) = state.db.with(|conn| {
                    let document = if encrypt {
                        export_at_with_proxy_verifiers(conn, &ids, true)?
                    } else {
                        export_at(conn, &ids)?
                    };
                    Ok((document, revision(conn)?))
                })?;
                let payload = if options.include_credentials {
                    portable::collect(&state, document, &expected_revision)?
                } else {
                    portable::Portable::configuration(document)
                };
                let bytes = Zeroizing::new(if encrypt {
                    serde_json::to_vec(&payload)?
                } else {
                    serde_json::to_vec_pretty(&payload.document)?
                });
                if bytes.len() > crypto::FILE_LIMIT {
                    return Err(invalid());
                }
                Ok(bytes)
            })
            .await?;
            tokio::task::spawn_blocking(move || {
                let output = if encrypt {
                    crypto::encrypt(&bytes, &password)?
                } else {
                    bytes.to_vec()
                };
                let path = path.to_string();
                job.commit()?;
                crate::settings_profiles::files::write_bytes(
                    std::path::Path::new(&path),
                    &output,
                    crypto::FILE_LIMIT,
                )
                .map_err(io_error)?;
                Ok(Some(path))
            })
            .await
            .map_err(|_| AppError::validation("hostTransfer.failed"))?
        })
        .await
}
pub(crate) fn publish(app: &AppHandle, state: &AppState, imported: &[Host]) -> AppResult<()> {
    state.set_settings(state.db.with(db::settings::load_checked)?);
    super::super::service(app, state).published_import(imported);
    mounts::runtime::changed(app);
    for domain in ["forwards", "settings"] {
        let _ = app.emit(
            "plugin://domain-changed",
            serde_json::json!({"domain":domain}),
        );
    }
    Ok(())
}
fn io_error(error: AppError) -> AppError {
    match error {
        AppError::Validation(key) if key.starts_with("profiles.") => {
            AppError::validation(key.replacen("profiles.", "hostTransfer.", 1))
        }
        other => other,
    }
}

fn commit_import(
    database: &crate::db::Database,
    key_root: &std::path::Path,
    payload: &portable::Portable,
    request: FileRequest,
    admit: impl FnOnce() -> AppResult<()>,
) -> AppResult<(apply::Applied, Vec<credentials::transfer::Write>)> {
    payload.validate()?;
    let selected = dependencies(&payload.document, &request.selected)?;
    let mut staged = portable::StagedKeys::create(key_root, payload, &selected)?;
    let (applied, pending) = database.with(|conn| {
        crate::db::atomic(conn, |conn| {
            if revision(conn)? != request.revision {
                return Err(changed());
            }
            admit()?;
            let applied = apply::apply_mapped(
                conn,
                ImportRequest {
                    document: payload.document.clone(),
                    revision: request.revision,
                    selected: request.selected,
                    copies: request.copies,
                    mount_points: request.mount_points,
                },
                &staged.paths,
            )?;
            // Capture exact credential authority before committing configuration.
            // Any capture failure rolls back configuration and staged key files.
            let mut pending = vec![];
            for secret in &payload.hosts {
                if let (Some(id), Some(password)) =
                    (applied.host_ids.get(&secret.host_id), &secret.password)
                {
                    let label = applied
                        .hosts
                        .iter()
                        .find(|h| &h.id == id)
                        .map(|h| h.name.clone())
                        .unwrap_or_else(|| id.clone());
                    pending.push(credentials::transfer::Write::host_at(
                        conn,
                        id,
                        label,
                        password.clone(),
                    )?);
                }
            }
            let settings = db::settings::load_checked(conn)?;
            for secret in &payload.proxies {
                if let Some(profile) = applied
                    .proxy_ids
                    .get(&secret.proxy_id)
                    .and_then(|id| settings.network.profiles.iter().find(|p| &p.id == id))
                {
                    pending.push(credentials::transfer::Write::proxy_at(
                        conn,
                        profile,
                        secret.password.clone(),
                    )?);
                }
            }
            Ok((applied, pending))
        })
    })?;
    staged.keep();
    Ok((applied, pending))
}

#[cfg(test)]
mod tests;
