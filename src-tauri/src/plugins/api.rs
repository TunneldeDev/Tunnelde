mod forwarding;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use base64::Engine;
use russh::ChannelMsg;
use serde::{de::DeserializeOwned, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::AsyncReadExt;
use tokio::sync::oneshot;

use crate::commands;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

const MAX_PAYLOAD: usize = 1024 * 1024 - 4096;
const MAX_REQUEST: usize = 256 * 1024;
const MAX_TEXT: usize = 512 * 1024;
const MAX_STORAGE: usize = 256 * 1024;
const FRONTEND_EVENT: &str = "plugin://workspace-request";
const CORE_CONTRACTS: &str = include_str!("contracts/core-v1.json");

#[derive(Clone)]
pub struct HostContext {
    pub app: AppHandle,
    pub id: String,
    pub fingerprint: String,
    pub permissions: Vec<String>,
    pub generation: u64,
    pub tool_client: Option<String>,
    pub tool_request: Option<uuid::Uuid>,
}

mod catalogue;
pub use catalogue::{ApiMethod, METHODS};

pub fn method_info(name: &str) -> Option<&'static ApiMethod> {
    METHODS.iter().find(|entry| entry.name == name)
}

// The plugin wire representation is deliberately independent from the SSH
// manager's internal session type. Keep existing fields for API v1 clients.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PluginSession {
    id: String,
    host_id: String,
    title: String,
    address: String,
    cols: u32,
    rows: u32,
    connected_at: i64,
}

impl From<crate::ssh::SessionInfo> for PluginSession {
    fn from(session: crate::ssh::SessionInfo) -> Self {
        Self {
            id: session.id,
            host_id: session.host_id,
            title: session.title,
            address: session.address,
            cols: session.cols,
            rows: session.rows,
            connected_at: session.connected_at,
        }
    }
}

pub(super) fn authorize(context: &HostContext, permissions: &[&str]) -> AppResult<()> {
    let state = context.app.state::<AppState>();
    state.plugins.security.authorize(
        &context.id,
        &context.fingerprint,
        &context.permissions,
        None,
        Some(context.generation),
    )?;
    for permission in permissions {
        state.plugins.security.authorize(
            &context.id,
            &context.fingerprint,
            &context.permissions,
            Some(permission),
            Some(context.generation),
        )?;
    }
    Ok(())
}

pub(super) fn field<T: DeserializeOwned>(params: &Value, key: &str) -> AppResult<T> {
    serde_json::from_value(
        params
            .get(key)
            .cloned()
            .ok_or_else(|| AppError::validation(format!("plugin.api.missing:{key}")))?,
    )
    .map_err(|_| AppError::validation(format!("plugin.api.invalid:{key}")))
}

pub(super) fn optional<T: DeserializeOwned>(params: &Value, key: &str) -> AppResult<Option<T>> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => serde_json::from_value(value.clone())
            .map(Some)
            .map_err(|_| AppError::validation(format!("plugin.api.invalid:{key}"))),
    }
}

fn encode(value: impl Serialize) -> AppResult<Value> {
    Ok(serde_json::to_value(value)?)
}

pub(super) fn validate_params(params: &Value) -> AppResult<()> {
    if !params.is_object() || serde_json::to_vec(params)?.len() > MAX_REQUEST {
        return Err(AppError::validation("plugin.api.invalidParams"));
    }
    Ok(())
}

fn describe_api() -> Value {
    static CONTRACTS: OnceLock<Value> = OnceLock::new();
    let contracts = CONTRACTS.get_or_init(|| {
        serde_json::from_str(CORE_CONTRACTS).expect("embedded core contracts must be valid JSON")
    });
    let methods: Vec<Value> = METHODS
        .iter()
        .map(|method| {
            let mut description =
                serde_json::to_value(method).expect("method metadata must serialize");
            if let Some(contract) = contracts["methods"].get(method.name) {
                description["contract"] = contract.clone();
            }
            description
        })
        .collect();
    json!({"version":1,"methods":methods})
}

pub async fn dispatch(context: &HostContext, method: &str, params: Value) -> AppResult<Value> {
    let entry =
        method_info(method).ok_or_else(|| AppError::validation("plugin.api.unknownMethod"))?;
    authorize(context, entry.permissions)?;
    validate_params(&params)?;
    let result = route(context, method, params).await?;
    // A revoked or replaced runtime must not receive a response after an await.
    authorize(context, entry.permissions)?;
    if serde_json::to_vec(&result)?.len() > MAX_PAYLOAD {
        return Err(AppError::validation("plugin.api.responseTooLarge"));
    }
    Ok(result)
}

async fn route(context: &HostContext, method: &str, params: Value) -> AppResult<Value> {
    let app = &context.app;
    let state = app.state::<AppState>();
    let change_session = params
        .get("sessionId")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let result = match method {
        name if name.starts_with("mounts.") => {
            crate::mounts::action(
                app.clone(),
                context.id.clone(),
                name.trim_start_matches("mounts.").into(),
                params,
                Some(context.generation),
            )
            .await
        }
        name if name.starts_with("forwards.") => forwarding::dispatch(context, name, params).await,
        "events.publish" => super::events::publish(context, params),
        name if name.starts_with("secrets.") => secret(context, name, &params).await,
        name if name.starts_with("tasks.") => super::tasks::dispatch(context, name, params).await,
        name if name.starts_with("runners.") => {
            super::runners::dispatch(context, name, params).await
        }
        "tools.invoke" => super::tools::invoke(context, params).await,
        "tools.cancel" | "tools.revokeClient" => {
            super::tools::cancel(context, method, &params).await
        }
        "api.describe" => Ok(describe_api()),
        "extensions.describe" => Ok(super::extensions::describe()),
        "log" => super::logging::write(&context.id, context.generation, params),
        "app.info" => encode(commands::app_info(app.clone(), state)),
        "app.openExternal" => {
            commands::open_external(app.clone(), field(&params, "url")?)?;
            Ok(Value::Null)
        }
        "settings.get" => encode(commands::settings_get(state)),
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
            encode(commands::settings_update(app.clone(), state, patch)?)
        }
        "hosts.snapshot" => encode(crate::services::hosts::snapshot(&state.db)?),
        "hosts.setSource" | "hosts.removeSource" | "hosts.sourcesSnapshot" => {
            super::host_sources::call(context, method, params)
        }
        "hostList.setColumn" | "hostList.removeColumn" => {
            super::host_columns::call(context, method, params)
        }
        "hosts.getFields" | "hosts.setFields" => super::host_fields::call(context, method, params),
        "hosts.create" => {
            encode(crate::services::hosts::service(app, &state).create(field(&params, "input")?)?)
        }
        "hosts.update" => encode(
            crate::services::hosts::service(app, &state)
                .update(&field::<String>(&params, "id")?, field(&params, "input")?)?,
        ),
        "hosts.delete" => {
            crate::services::hosts::service(app, &state)
                .delete(&field::<String>(&params, "id")?)?;
            Ok(Value::Null)
        }
        "hosts.markUsed" => {
            crate::services::hosts::service(app, &state)
                .mark_used(&field::<String>(&params, "id")?)?;
            Ok(Value::Null)
        }
        "hosts.reorder" => {
            crate::services::hosts::service(app, &state)
                .reorder(&field::<Vec<String>>(&params, "ids")?)?;
            Ok(Value::Null)
        }
        "groups.create" => encode(
            crate::services::hosts::service(app, &state).create_group(field(&params, "input")?)?,
        ),
        "groups.update" => encode(
            crate::services::hosts::service(app, &state)
                .update_group(&field::<String>(&params, "id")?, field(&params, "input")?)?,
        ),
        "groups.delete" => {
            crate::services::hosts::service(app, &state)
                .delete_group(&field::<String>(&params, "id")?)?;
            Ok(Value::Null)
        }
        "sessions.list" => encode(
            commands::ssh_sessions(state)
                .into_iter()
                .map(PluginSession::from)
                .collect::<Vec<_>>(),
        ),
        "sessions.connect" => encode(PluginSession::from(
            super::sessions::connect(context, field(&params, "request")?).await?,
        )),
        "sessions.disconnect" => {
            commands::ssh_disconnect(app.clone(), field(&params, "sessionId")?)?;
            Ok(Value::Null)
        }
        "sessions.requestHandoff" => {
            encode(super::sessions::request_handoff(context, field(&params, "sessionId")?).await?)
        }
        "sessions.exec" => execute(context, &params).await,
        "terminal.write" => {
            let data: String = field(&params, "data")?;
            commands::ssh_write(
                app.clone(),
                field(&params, "sessionId")?,
                base64::engine::general_purpose::STANDARD.encode(data.as_bytes()),
            )?;
            Ok(Value::Null)
        }
        "terminal.resize" => {
            commands::ssh_resize(
                app.clone(),
                field(&params, "sessionId")?,
                field(&params, "cols")?,
                field(&params, "rows")?,
            )?;
            Ok(Value::Null)
        }
        "files.local.home" => encode(commands::local_home()),
        "files.local.list" => encode(commands::local_list(optional(&params, "path")?)?),
        "files.local.readText" => local_read(field(&params, "path")?).await,
        "files.local.writeText" => write_local(context, &params, |_, _| Ok(())).await,
        "files.local.createFile" => {
            commands::local_create_file(field(&params, "path")?)?;
            Ok(Value::Null)
        }
        "files.local.mkdir" => {
            commands::local_mkdir(field(&params, "path")?)?;
            Ok(Value::Null)
        }
        "files.local.rename" => {
            // Plugin rename remains atomic. Copy-based moves require a
            // separately owned transfer lifecycle, not the UI fallback.
            crate::ssh::files::local_rename(
                field(&params, "from")?,
                field(&params, "to")?,
                optional(&params, "overwrite")?.unwrap_or(false),
            )?;
            Ok(Value::Null)
        }
        "files.local.copy" | "files.sftp.copy" => {
            let session: Option<String> = if method == "files.sftp.copy" {
                let session: String = field(&params, "sessionId")?;
                state.ssh.handle(&session)?;
                Some(session)
            } else {
                None
            };
            let task = crate::ssh::files::start_copy(
                app.clone(),
                crate::ssh::files::Endpoint {
                    session: session.clone(),
                    path: field(&params, "from")?,
                },
                crate::ssh::files::Endpoint {
                    session,
                    path: field(&params, "to")?,
                },
                optional::<bool>(&params, "overwrite")?.unwrap_or(false),
                Some(super::security::Lease {
                    id: context.id.clone(),
                    fingerprint: context.fingerprint.clone(),
                    permissions: context.permissions.clone(),
                    generation: context.generation,
                }),
            )?;
            let id = task.id.clone();
            if !super::tools::register_resource(context, &id, true) {
                state
                    .transfers
                    .cancel_owned(&id, &context.id, context.generation);
                return Err(AppError::validation("plugin.tools.cancelled"));
            }
            let _request = super::tools::CopyRequest(context.clone(), id);
            task.wait().await?;
            Ok(Value::Null)
        }
        "files.local.delete" => {
            commands::local_delete(field(&params, "path")?, field(&params, "isDir")?)?;
            Ok(Value::Null)
        }
        "files.sftp.resolveDirectory" => encode(
            crate::ssh::files::remote_resolve_directory(
                app,
                &field::<String>(&params, "sessionId")?,
                optional(&params, "path")?,
            )
            .await?,
        ),
        "files.sftp.list" => encode(
            commands::sftp_list(
                app.clone(),
                field(&params, "sessionId")?,
                optional(&params, "path")?,
            )
            .await?,
        ),
        "files.sftp.readText" => encode(
            commands::sftp_read_text(
                app.clone(),
                field(&params, "sessionId")?,
                field(&params, "path")?,
            )
            .await?,
        ),
        "files.sftp.writeText" => {
            commands::sftp_write_text(
                app.clone(),
                field(&params, "sessionId")?,
                field(&params, "path")?,
                field(&params, "content")?,
                optional(&params, "baseline")?,
            )
            .await?;
            Ok(Value::Null)
        }
        "files.sftp.createFile" => {
            commands::sftp_create_file(
                app.clone(),
                field(&params, "sessionId")?,
                field(&params, "path")?,
            )
            .await?;
            Ok(Value::Null)
        }
        "files.sftp.mkdir" => {
            commands::sftp_mkdir(
                app.clone(),
                field(&params, "sessionId")?,
                field(&params, "path")?,
            )
            .await?;
            Ok(Value::Null)
        }
        "files.sftp.rename" => {
            commands::sftp_rename(
                app.clone(),
                field(&params, "sessionId")?,
                field(&params, "from")?,
                field(&params, "to")?,
                optional(&params, "overwrite")?,
            )
            .await?;
            Ok(Value::Null)
        }
        "files.sftp.delete" => {
            commands::sftp_delete(
                app.clone(),
                field(&params, "sessionId")?,
                field(&params, "path")?,
                field(&params, "isDir")?,
            )
            .await?;
            Ok(Value::Null)
        }
        "files.upload" | "files.download" => {
            let session_id: String = field(&params, "sessionId")?;
            // Validate the session before registering any background task.
            state.ssh.handle(&session_id)?;
            let local = crate::ssh::files::Endpoint {
                session: None,
                path: field(&params, "localPath")?,
            };
            let remote = crate::ssh::files::Endpoint {
                session: Some(session_id),
                path: field(&params, "remotePath")?,
            };
            let (from, to) = if method == "files.upload" {
                (local, remote)
            } else {
                (remote, local)
            };
            let transfer_id = crate::ssh::files::spawn_plugin_transfer(
                app.clone(),
                from,
                to,
                optional::<bool>(&params, "overwrite")?.unwrap_or(false),
                super::security::Lease {
                    id: context.id.clone(),
                    fingerprint: context.fingerprint.clone(),
                    permissions: context.permissions.clone(),
                    generation: context.generation,
                },
            )?;
            if !super::tools::register_resource(context, &transfer_id, true) {
                state
                    .transfers
                    .cancel_owned(&transfer_id, &context.id, context.generation);
                return Err(AppError::validation("plugin.tools.cancelled"));
            }
            encode(transfer_id)
        }
        "files.cancelTransfer" => encode(state.transfers.cancel_owned(
            &field::<String>(&params, "transferId")?,
            &context.id,
            context.generation,
        )),
        "files.transferStatus" => encode(state.transfers.status_owned(
            &field::<String>(&params, "transferId")?,
            &context.id,
            context.generation,
        )),
        "monitor.system" => encode(commands::system_stats(state)),
        "monitor.stats" => {
            encode(commands::remote_stats(app.clone(), field(&params, "sessionId")?).await?)
        }
        "monitor.processes" => {
            encode(commands::remote_processes(app.clone(), field(&params, "sessionId")?).await?)
        }
        "monitor.kill" => {
            commands::remote_kill(
                app.clone(),
                field(&params, "sessionId")?,
                field(&params, "pid")?,
                None,
            )
            .await?;
            Ok(Value::Null)
        }
        "history.list" => encode(commands::history_list(
            app.clone(),
            state,
            field(&params, "hostId")?,
            optional(&params, "limit")?,
        )?),
        "history.record" => encode(commands::history_record(
            app.clone(),
            state,
            field(&params, "hostId")?,
            field(&params, "command")?,
        )?),
        "history.delete" => {
            commands::history_delete(app.clone(), state, field(&params, "id")?)?;
            Ok(Value::Null)
        }
        "history.clear" => {
            commands::history_clear(app.clone(), state, field(&params, "hostId")?)?;
            Ok(Value::Null)
        }
        "clipboard.readText" => encode(commands::clipboard_read_text(app.clone()).await?),
        "clipboard.writeText" => {
            commands::clipboard_write_text(app.clone(), field(&params, "text")?).await?;
            Ok(Value::Null)
        }
        "storage.get" | "storage.set" | "storage.delete" => storage(context, method, &params).await,
        "hostList.setDecorations" | "hostList.removeDecorations" => {
            super::host_list::call(context, method, params)
        }
        "statusBar.set" | "statusBar.remove" => super::status_bar::call(context, method, params),
        "tabBar.set" | "tabBar.remove" => super::tab_bar::call(context, method, params),
        name if name.starts_with("workspace.")
            || name.starts_with("ui.")
            || name.starts_with("editor.") =>
        {
            frontend_request(context, name, params).await
        }
        _ => Err(AppError::validation("plugin.api.unknownMethod")),
    }?;
    let domain = match method {
        "sessions.connect" | "sessions.disconnect" | "sessions.requestHandoff" => Some("sessions"),
        name if name.starts_with("files.")
            && !matches!(
                name,
                "files.upload"
                    | "files.download"
                    | "files.cancelTransfer"
                    | "files.transferStatus"
                    | "files.local.writeText"
                    | "files.local.copy"
                    | "files.sftp.copy"
            )
            && !name.ends_with(".readText")
            && !name.ends_with(".list")
            && !name.ends_with(".home") =>
        {
            Some("files")
        }
        _ => None,
    };
    if let Some(domain) = domain {
        let _ = app.emit(
            "plugin://domain-changed",
            json!({"domain":domain,"sessionId":change_session}),
        );
    }
    Ok(result)
}

fn validate_text(bytes: &[u8]) -> AppResult<()> {
    if bytes.len() > MAX_TEXT {
        return Err(AppError::validation("plugin.api.fileTooLarge"));
    }
    if bytes.contains(&0) || std::str::from_utf8(bytes).is_err() {
        return Err(AppError::validation("plugin.api.invalidText"));
    }
    Ok(())
}

async fn local_read(path: String) -> AppResult<Value> {
    tokio::task::spawn_blocking(move || {
        let target = std::fs::canonicalize(path)?;
        let mut file = crate::platform::editor_file::open_regular(&target, false)?;
        let mut bytes = Vec::new();
        std::io::Read::read_to_end(
            &mut std::io::Read::take(&mut file, MAX_TEXT as u64 + 1),
            &mut bytes,
        )?;
        validate_text(&bytes)?;
        Ok(json!({"size":bytes.len(),"content":String::from_utf8(bytes).map_err(|_| AppError::validation("plugin.api.invalidText"))?}))
    }).await.map_err(|error| AppError::internal(error.to_string()))?
}

pub(super) async fn write_local(
    context: &HostContext,
    params: &Value,
    check_scope: impl Fn(&Path, &str) -> AppResult<()> + Send + 'static,
) -> AppResult<Value> {
    let path: String = field(params, "path")?;
    let content: String = field(params, "content")?;
    let baseline: Option<String> = optional(params, "baseline")?;
    validate_text(content.as_bytes())?;
    if let Some(baseline) = &baseline {
        validate_text(baseline.as_bytes())?;
    }
    authorize(context, &["fs.write"])?;
    let app = context.app.clone();
    let context = context.clone();
    crate::ssh::files::local_editor::save_checked(
        context.app.clone(),
        path,
        content,
        baseline,
        move |target, original| {
            // Recheck on the blocking worker after lock acquisition and again
            // immediately before atomic publication, including RPC revocation.
            authorize(&context, &["fs.write"])?;
            if let Some(client) = &context.tool_client {
                super::tools::authorize_client(&context, client)?;
            }
            validate_text(original.as_bytes())?;
            check_scope(target, original)
        },
        move || {
            // Direct calls and scoped AI/MCP tools share this publication event.
            // It survives RPC cancellation after the atomic publication gate.
            let _ = app.emit(
                "plugin://domain-changed",
                json!({"domain":"files","sessionId":null}),
            );
        },
    )
    .await?;
    Ok(Value::Null)
}

// Cancellation drops the host dispatch future immediately. Close the dedicated
// channel from a detached, bounded cleanup task even when that future cannot
// reach its normal async cleanup path.
struct ExecChannel(Option<russh::Channel<russh::client::Msg>>);

impl Drop for ExecChannel {
    fn drop(&mut self) {
        if let Some(channel) = self.0.take() {
            if let Ok(runtime) = tokio::runtime::Handle::try_current() {
                runtime.spawn(async move {
                    let _ = tokio::time::timeout(Duration::from_secs(2), channel.close()).await;
                });
            }
        }
    }
}

async fn execute(context: &HostContext, params: &Value) -> AppResult<Value> {
    let session_id: String = field(params, "sessionId")?;
    let command: String = field(params, "command")?;
    let timeout = optional::<u64>(params, "timeoutMs")?.unwrap_or(20_000);
    if !(100..=60_000).contains(&timeout)
        || command.trim().is_empty()
        || command.len() > 64 * 1024
        || command.contains('\0')
    {
        return Err(AppError::validation("plugin.api.invalidExec"));
    }
    let handle = context.app.state::<AppState>().ssh.handle(&session_id)?;
    let channel = tokio::time::timeout(Duration::from_secs(8), handle.channel_open_session())
        .await
        .map_err(|_| AppError::validation("plugin.api.execTimeout"))?
        .map_err(|error| AppError::Ssh(format!("plugin.exec.channel:{error}")))?;
    let mut guard = ExecChannel(Some(channel));
    let channel = guard.0.as_mut().expect("exec channel is present");
    let result = tokio::time::timeout(Duration::from_millis(timeout), async {
        authorize(context, &["ssh.exec"])?;
        channel.exec(true, command).await.map_err(|error| AppError::Ssh(format!("plugin.exec:{error}")))?;
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let mut exit_code = None;
        let mut signal = None;
        loop {
            tokio::select! {
                message = channel.wait() => match message {
                    Some(ChannelMsg::Data { data }) => stdout.extend_from_slice(&data),
                    Some(ChannelMsg::ExtendedData { data, .. }) => stderr.extend_from_slice(&data),
                    Some(ChannelMsg::ExitStatus { exit_status }) => exit_code = Some(exit_status),
                    Some(ChannelMsg::ExitSignal { signal_name, .. }) => signal = Some(format!("{signal_name:?}")),
                    Some(ChannelMsg::Close) | None => break,
                    _ => {}
                },
                _ = tokio::time::sleep(Duration::from_millis(250)) => { authorize(context, &["ssh.exec"])?; }
            }
            if stdout.len().saturating_add(stderr.len()) > MAX_PAYLOAD { return Err(AppError::validation("plugin.api.outputTooLarge")); }
        }
        Ok(json!({"stdout":String::from_utf8_lossy(&stdout),"stderr":String::from_utf8_lossy(&stderr),"exitCode":exit_code,"signal":signal}))
    }).await.unwrap_or_else(|_| Err(AppError::validation("plugin.api.execTimeout")));
    let _ = channel.close().await;
    guard.0.take();
    result
}

fn storage_path(root: &Path, id: &str) -> PathBuf {
    root.join(format!("{:x}.json", Sha256::digest(id.as_bytes())))
}

fn storage_key(params: &Value) -> AppResult<String> {
    let key: String = field(params, "key")?;
    if key.is_empty()
        || key.len() > 128
        || !key
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
        || ["__proto__", "constructor", "prototype"].contains(&key.as_str())
    {
        return Err(AppError::validation("plugin.api.invalidStorageKey"));
    }
    Ok(key)
}

async fn secret(context: &HostContext, method: &str, params: &Value) -> AppResult<Value> {
    let key = storage_key(params)?;
    let identity = format!("plugin:{}:{}", context.id, key);
    let value: Option<String> = if method == "secrets.set" {
        Some(field(params, "value")?)
    } else {
        None
    };
    if value.as_ref().is_some_and(|value| value.len() > 16 * 1024) {
        return Err(AppError::validation("plugin.api.secretTooLarge"));
    }
    let method = method.to_owned();
    let context = context.clone();
    tokio::task::spawn_blocking(move || {
        authorize(&context, &["secrets"])?;
        match method.as_str() {
            "secrets.get" => encode(crate::vault::load(&identity)?),
            "secrets.set" => {
                crate::vault::save(&identity, value.as_deref().unwrap_or_default())?;
                Ok(Value::Null)
            }
            "secrets.delete" => {
                crate::vault::forget(&identity)?;
                Ok(Value::Null)
            }
            _ => Err(AppError::validation("plugin.api.unknownMethod")),
        }
    })
    .await
    .map_err(|_| AppError::internal("plugin.api.keyringFailed"))?
}

async fn storage(context: &HostContext, method: &str, params: &Value) -> AppResult<Value> {
    let root = context
        .app
        .state::<AppState>()
        .storage
        .dir(crate::storage::layout::Category::PluginData)
        .to_path_buf();
    storage_at(&root, &context.id, method, params, || {
        authorize(context, &[])
    })
    .await
}

async fn storage_at(
    root: &Path,
    id: &str,
    method: &str,
    params: &Value,
    authorize_request: impl Fn() -> AppResult<()>,
) -> AppResult<Value> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    if !matches!(method, "storage.get" | "storage.set" | "storage.delete") {
        return Err(AppError::validation("plugin.api.unknownMethod"));
    }
    let key = storage_key(params)?;
    let _guard = LOCK
        .get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await;
    authorize_request()?;
    let path = storage_path(root, id);
    let mut values: Map<String, Value> = match tokio::fs::File::open(&path).await {
        Ok(file) => {
            let mut bytes = Vec::new();
            file.take(MAX_STORAGE as u64 + 1)
                .read_to_end(&mut bytes)
                .await?;
            if bytes.len() > MAX_STORAGE {
                return Err(AppError::validation("plugin.api.storageTooLarge"));
            }
            serde_json::from_slice(&bytes)
                .map_err(|_| AppError::validation("plugin.api.invalidStorage"))?
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Map::new(),
        Err(error) => return Err(error.into()),
    };
    if method == "storage.get" {
        return Ok(values.get(&key).cloned().unwrap_or(Value::Null));
    }
    if method == "storage.set" {
        values.insert(key, field(params, "value")?);
    } else {
        values.remove(&key);
    }
    let bytes = serde_json::to_vec(&values)?;
    if bytes.len() > MAX_STORAGE {
        return Err(AppError::validation("plugin.api.storageTooLarge"));
    }
    let root = path
        .parent()
        .ok_or_else(|| AppError::internal("plugin.api.storagePath"))?;
    tokio::fs::create_dir_all(root).await?;
    let temporary = root.join(format!(".{}.tmp", uuid::Uuid::new_v4()));
    let result = async {
        tokio::fs::write(&temporary, bytes).await?;
        authorize_request()?;
        tokio::fs::rename(&temporary, &path).await?;
        Ok(Value::Null)
    }
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(&temporary).await;
    }
    result
}

struct PendingFrontend {
    context: HostContext,
    permissions: &'static [&'static str],
    reply: oneshot::Sender<AppResult<Value>>,
}
struct FrontendRequestGuard {
    app: AppHandle,
    request_id: String,
}
impl Drop for FrontendRequestGuard {
    fn drop(&mut self) {
        let removed = pending_frontend()
            .lock()
            .ok()
            .and_then(|mut pending| pending.remove(&self.request_id));
        if removed.is_some() {
            let _ = self.app.emit(
                "plugin://workspace-cancelled",
                json!({"requestId": self.request_id}),
            );
        }
    }
}
fn pending_frontend() -> &'static Mutex<HashMap<String, PendingFrontend>> {
    static PENDING: OnceLock<Mutex<HashMap<String, PendingFrontend>>> = OnceLock::new();
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(super) async fn frontend_request(
    context: &HostContext,
    method: &str,
    params: Value,
) -> AppResult<Value> {
    // Internal frontend command delivery is not a public RPC capability.
    let permissions: &'static [&'static str] = if method == "__frontend.command" {
        &["ui.trusted"]
    } else {
        method_info(method)
            .ok_or_else(|| AppError::validation("plugin.api.unknownMethod"))?
            .permissions
    };
    let request_id = uuid::Uuid::new_v4().to_string();
    let (sender, receiver) = oneshot::channel();
    {
        let mut pending = pending_frontend()
            .lock()
            .map_err(|_| AppError::internal("plugin.api.lock"))?;
        if pending.len() >= 64
            || pending
                .values()
                .filter(|item| item.context.id == context.id)
                .count()
                >= 8
        {
            return Err(AppError::validation("plugin.api.busy"));
        }
        pending.insert(
            request_id.clone(),
            PendingFrontend {
                context: context.clone(),
                permissions,
                reply: sender,
            },
        );
    }
    let _guard = FrontendRequestGuard {
        app: context.app.clone(),
        request_id: request_id.clone(),
    };
    let result = async {
        context.app.emit(
            FRONTEND_EVENT,
            json!({"requestId":request_id,"pluginId":context.id,"method":method,"params":params}),
        )?;
        tokio::time::timeout(
            Duration::from_secs(if matches!(method, "ui.confirm" | "__frontend.command") {
                60
            } else {
                15
            }),
            receiver,
        )
        .await
        .map_err(|_| AppError::validation("plugin.api.frontendTimeout"))?
        .map_err(|_| AppError::validation("plugin.api.frontendClosed"))?
    }
    .await;
    result
}

#[tauri::command]
pub fn plugin_workspace_authorize(request_id: String) -> AppResult<()> {
    let pending = pending_frontend()
        .lock()
        .map_err(|_| AppError::internal("plugin.api.lock"))?;
    let request = pending
        .get(&request_id)
        .ok_or_else(|| AppError::validation("plugin.api.requestExpired"))?;
    authorize(&request.context, request.permissions)
}

#[tauri::command]
pub fn plugin_workspace_reply(
    request_id: String,
    result: Option<Value>,
    error: Option<String>,
) -> AppResult<()> {
    let request = pending_frontend()
        .lock()
        .map_err(|_| AppError::internal("plugin.api.lock"))?
        .remove(&request_id)
        .ok_or_else(|| AppError::validation("plugin.api.requestExpired"))?;
    let result = authorize(&request.context, request.permissions)
        .and_then(|_| frontend_result(result, error));
    let _ = request.reply.send(result);
    Ok(())
}

fn frontend_result(result: Option<Value>, error: Option<String>) -> AppResult<Value> {
    match error {
        Some(error) => Err(AppError::validation(format!(
            "plugin.api.frontend:{}",
            error.chars().take(512).collect::<String>()
        ))),
        None => {
            let result = result.unwrap_or(Value::Null);
            if serde_json::to_vec(&result)?.len() > MAX_PAYLOAD {
                Err(AppError::validation("plugin.api.responseTooLarge"))
            } else {
                Ok(result)
            }
        }
    }
}

#[cfg(test)]
#[path = "contracts/tests.rs"]
mod contract_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[tokio::test]
    async fn local_text_reads_are_bounded_and_reject_nonregular_or_binary_inputs() {
        let root =
            std::env::temp_dir().join(format!("tunnelde-plugin-read-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let file = root.join("note.txt");
        for (bytes, error) in [
            (b"hello".to_vec(), None),
            (vec![b'x'; MAX_TEXT], None),
            (vec![b'x'; MAX_TEXT + 1], Some("plugin.api.fileTooLarge")),
            (vec![b'a', 0], Some("plugin.api.invalidText")),
            (vec![255], Some("plugin.api.invalidText")),
        ] {
            std::fs::write(&file, &bytes).unwrap();
            let result = local_read(file.to_string_lossy().into_owned()).await;
            if let Some(error) = error {
                assert_eq!(result.unwrap_err().to_string(), error);
            } else {
                assert_eq!(
                    result.unwrap(),
                    json!({"size":bytes.len(),"content":String::from_utf8(bytes).unwrap()})
                );
            }
        }
        assert!(local_read(root.to_string_lossy().into_owned())
            .await
            .is_err());
        #[cfg(unix)]
        {
            let fifo = root.join("pipe");
            assert!(std::process::Command::new("mkfifo")
                .args(["-m", "600"])
                .arg(&fifo)
                .status()
                .unwrap()
                .success());
            assert!(tokio::time::timeout(
                Duration::from_secs(2),
                local_read(fifo.to_string_lossy().into_owned())
            )
            .await
            .unwrap()
            .is_err());
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn plugin_session_wire_shape_is_explicit_and_preserves_existing_fields() {
        let session = crate::ssh::SessionInfo {
            id: "session".into(),
            host_id: "host".into(),
            title: "Example".into(),
            address: "example.test:22".into(),
            cols: 80,
            rows: 24,
            connected_at: 123,
            terminal: true,
            purpose: None,
        };
        assert_eq!(
            serde_json::to_value(PluginSession::from(session)).unwrap(),
            json!({"id":"session","hostId":"host","title":"Example", "address":"example.test:22", "cols":80,"rows":24,"connectedAt":123})
        );
    }

    #[test]
    fn discovery_preserves_legacy_fields_and_publishes_stability_metadata() {
        let entry = serde_json::to_value(method_info("api.describe").unwrap()).unwrap();
        assert_eq!(entry["name"], "api.describe");
        assert_eq!(entry["permissions"], json!([]));
        assert_eq!(entry["params"], "{}");
        assert!(entry["description"].as_str().is_some_and(|s| !s.is_empty()));
        assert_eq!(entry["stability"], "stable");
        assert_eq!(entry["since"], "0.21.0");
        assert_eq!(entry["deprecated"], Value::Null);
        let experimental =
            serde_json::to_value(method_info("workspace.openPage").unwrap()).unwrap();
        assert_eq!(experimental["stability"], "experimental");
        assert_eq!(experimental["since"], Value::Null);
    }

    // Source organization must not change existing method metadata or stable schemas.
    #[test]
    fn domain_catalogue_preserves_existing_method_contracts() {
        let previous: Value = serde_json::from_str(include_str!(
            "../../../tests/fixtures/plugin-compat/rpc-catalogue-v1/catalogue.json"
        ))
        .unwrap();
        let current = describe_api();
        let keyed = |value: &Value| -> std::collections::BTreeMap<String, Value> {
            value["methods"]
                .as_array()
                .unwrap()
                .iter()
                .map(|method| (method["name"].as_str().unwrap().to_owned(), method.clone()))
                .collect()
        };
        assert_eq!(current["version"], previous["version"]);
        let actual = keyed(&current);
        for (name, contract) in keyed(&previous) {
            assert_eq!(
                actual.get(&name),
                Some(&contract),
                "changed contract: {name}"
            );
        }
        // The decomposition must not silently drop or accidentally introduce methods.
        assert_eq!(actual.len(), previous["methods"].as_array().unwrap().len());
    }

    // CI validates the actual serialized host response against the frozen v1 schema.
    #[test]
    fn emit_discovery_contract_response() {
        let response = describe_api();
        assert_eq!(response["version"], 1);
        assert!(response["methods"].as_array().unwrap().len() > 1);
        if let Some(path) = std::env::var_os("TUNNELDE_API_CONTRACT_OUTPUT") {
            std::fs::write(path, serde_json::to_vec(&response).unwrap()).unwrap();
        }
    }

    #[test]
    fn exposes_only_unique_documented_methods_with_declared_permissions() {
        let mut names = HashSet::new();
        for entry in METHODS.iter() {
            assert!(
                names.insert(entry.name),
                "duplicate API method {}",
                entry.name
            );
            assert!(!entry.params.is_empty() && !entry.description.is_empty());
            assert!(matches!(
                entry.stability,
                "stable" | "experimental" | "deprecated"
            ));
            if entry.stability == "stable" {
                assert!(
                    entry.since.is_some(),
                    "stable method {} needs since",
                    entry.name
                );
                assert!(
                    entry.deprecated.is_none(),
                    "stable method {} cannot be deprecated",
                    entry.name
                );
            }
            if entry.stability == "deprecated" {
                assert!(
                    entry.deprecated.is_some(),
                    "deprecated method {} needs guidance",
                    entry.name
                );
            }
            for permission in entry.permissions {
                assert!(
                    super::super::security::PERMISSIONS.contains(permission),
                    "unknown permission {permission}"
                );
            }
        }
        for forbidden in [
            "invoke",
            "commands.invoke",
            "vault.read",
            "credential.read",
            "ssh.trust",
            "plugin.start",
            "settings.reset",
        ] {
            assert!(method_info(forbidden).is_none());
        }
        assert_eq!(
            method_info("sessions.exec").unwrap().permissions,
            ["ssh.exec"]
        );
        assert_eq!(
            method_info("files.local.copy").unwrap().permissions,
            ["fs.read", "fs.write"]
        );
        let describe = method_info("api.describe").unwrap();
        assert_eq!(describe.stability, "stable");
        assert_eq!(describe.since, Some("0.21.0"));
    }

    #[test]
    fn validates_parameter_types_and_storage_names() {
        assert!(field::<String>(&json!({"id":42}), "id").is_err());
        assert!(field::<String>(&json!({}), "id").is_err());
        assert!(optional::<bool>(&json!({"overwrite":"yes"}), "overwrite").is_err());
        for key in ["", "../other", "a/b", "__proto__", "constructor", "键"] {
            assert!(storage_key(&json!({"key":key})).is_err());
        }
        assert_eq!(
            storage_key(&json!({"key":"draft.v1-2_3"})).unwrap(),
            "draft.v1-2_3"
        );
    }

    #[test]
    fn scopes_storage_by_plugin_identity_without_path_interpolation() {
        let root = Path::new("store");
        let a = storage_path(root, "plugin-a");
        assert_ne!(a, storage_path(root, "plugin-b"));
        assert_eq!(a, storage_path(root, "plugin-a"));
        assert_eq!(storage_path(root, "../../secret").parent(), Some(root));
    }

    #[tokio::test]
    async fn plugin_storage_persists_isolates_and_removes_values() {
        let root =
            std::env::temp_dir().join(format!("tunnelde-storage-test-{}", uuid::Uuid::new_v4()));
        let key = json!({"key": "draft"});
        let value = json!({"key": "draft", "value": {"number": 42, "enabled": true}});
        assert_eq!(
            storage_at(&root, "a", "storage.get", &key, || Ok(()))
                .await
                .unwrap(),
            Value::Null
        );
        assert_eq!(
            storage_at(&root, "a", "storage.set", &value, || Ok(()))
                .await
                .unwrap(),
            Value::Null
        );
        assert_eq!(
            storage_at(&root, "a", "storage.get", &key, || Ok(()))
                .await
                .unwrap(),
            value["value"]
        );
        assert_eq!(
            storage_at(&root, "b", "storage.get", &key, || Ok(()))
                .await
                .unwrap(),
            Value::Null
        );
        assert_eq!(
            storage_at(&root, "a", "storage.delete", &key, || Ok(()))
                .await
                .unwrap(),
            Value::Null
        );
        assert_eq!(
            storage_at(&root, "a", "storage.get", &key, || Ok(()))
                .await
                .unwrap(),
            Value::Null
        );
        tokio::fs::remove_dir_all(root).await.unwrap();
    }

    #[tokio::test]
    async fn plugin_storage_rechecks_authorization_before_commit_and_cleans_staging() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let root =
            std::env::temp_dir().join(format!("tunnelde-storage-test-{}", uuid::Uuid::new_v4()));
        let key = json!({"key": "draft"});
        let original = json!({"key": "draft", "value": "original"});
        storage_at(&root, "a", "storage.set", &original, || Ok(()))
            .await
            .unwrap();
        let checks = AtomicUsize::new(0);
        let changed = json!({"key": "draft", "value": "changed"});
        let result = storage_at(&root, "a", "storage.set", &changed, || {
            if checks.fetch_add(1, Ordering::SeqCst) == 0 {
                Ok(())
            } else {
                Err(AppError::validation("test.revoked"))
            }
        })
        .await;
        assert!(result.is_err());
        assert_eq!(checks.load(Ordering::SeqCst), 2);
        assert_eq!(
            storage_at(&root, "a", "storage.get", &key, || Ok(()))
                .await
                .unwrap(),
            "original"
        );
        let mut entries = tokio::fs::read_dir(&root).await.unwrap();
        assert!(entries.next_entry().await.unwrap().is_some());
        assert!(entries.next_entry().await.unwrap().is_none());
        tokio::fs::remove_dir_all(root).await.unwrap();
    }

    #[tokio::test]
    async fn plugin_storage_rejects_oversized_writes_without_losing_existing_data() {
        let root =
            std::env::temp_dir().join(format!("tunnelde-storage-test-{}", uuid::Uuid::new_v4()));
        let key = json!({"key": "draft"});
        storage_at(
            &root,
            "a",
            "storage.set",
            &json!({"key":"draft","value":"original"}),
            || Ok(()),
        )
        .await
        .unwrap();
        assert!(storage_at(
            &root,
            "a",
            "storage.set",
            &json!({"key":"draft","value":"x".repeat(MAX_STORAGE)}),
            || Ok(())
        )
        .await
        .is_err());
        assert_eq!(
            storage_at(&root, "a", "storage.get", &key, || Ok(()))
                .await
                .unwrap(),
            "original"
        );
        tokio::fs::remove_dir_all(root).await.unwrap();
    }

    #[tokio::test]
    async fn plugin_storage_serializes_concurrent_updates() {
        let root =
            std::env::temp_dir().join(format!("tunnelde-storage-test-{}", uuid::Uuid::new_v4()));
        let first = json!({"key": "first", "value": 1});
        let second = json!({"key": "second", "value": 2});
        let (a, b) = tokio::join!(
            storage_at(&root, "a", "storage.set", &first, || Ok(())),
            storage_at(&root, "a", "storage.set", &second, || Ok(())),
        );
        a.unwrap();
        b.unwrap();
        assert_eq!(
            storage_at(
                &root,
                "a",
                "storage.get",
                &json!({"key":"first"}),
                || Ok(())
            )
            .await
            .unwrap(),
            1
        );
        assert_eq!(
            storage_at(&root, "a", "storage.get", &json!({"key":"second"}), || Ok(
                ()
            ))
            .await
            .unwrap(),
            2
        );
        tokio::fs::remove_dir_all(root).await.unwrap();
    }

    #[test]
    fn refuses_large_or_binary_text_instead_of_truncating_it() {
        assert!(validate_text(b"hello").is_ok());
        assert!(validate_text(b"hello\0secret").is_err());
        assert!(validate_text(&[0xff]).is_err());
        assert!(validate_text(&vec![b'a'; MAX_TEXT + 1]).is_err());
    }
}
