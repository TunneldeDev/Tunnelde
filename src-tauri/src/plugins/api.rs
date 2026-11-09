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
}

#[derive(Serialize)]
pub struct ApiMethod {
    pub name: &'static str,
    pub permissions: &'static [&'static str],
    pub params: &'static str,
    pub description: &'static str,
    /// Compatibility state for this method. New methods start experimental;
    /// promotion to stable is an explicit contract decision.
    pub stability: &'static str,
    pub since: Option<&'static str>,
    pub deprecated: Option<&'static str>,
}

macro_rules! method {
    ($name:literal, [$($permission:literal),*], $params:literal, $description:literal) => {
        ApiMethod {
            name: $name,
            permissions: &[$($permission),*],
            params: $params,
            description: $description,
            stability: "experimental",
            since: None,
            deprecated: None,
        }
    };
}

macro_rules! stable_method {
    ($name:literal, [$($permission:literal),*], $params:literal, $description:literal, $since:literal) => {
        ApiMethod {
            name: $name,
            permissions: &[$($permission),*],
            params: $params,
            description: $description,
            stability: "stable",
            since: Some($since),
            deprecated: None,
        }
    };
}

pub const METHODS: &[ApiMethod] = &[
    method!("extensions.describe", [], "{}", "Discover implemented extension points, their domain, permissions, registration methods, composition and runtime ownership. The experimental directory is not a completeness or authorization claim; use api.describe for individual method contracts."),
    method!("hostList.setDecorations", ["hosts.read", "workspace.write"], "{id:string,priority?:number,decorations:{hostId:string,badge?:string,description?:string,tooltip?:string,icon?:server|cloud|container|database|globe|code|terminal|shield|key|activity,tone?:neutral|info|success|warning|error}[]}", "Replace a runtime-owned collection of host-list decorations. Plain text, semantic colors and host-rendered icons; host names, addresses, connection state and actions remain intact. At most 256 distinct existing hosts per collection, 8 collections per plugin and 128 total. Empty decorations clears a collection. Higher priority wins icon/description; badges combine in deterministic order. Removed on stop, crash, revocation or restart; never modifies saved hosts."),
    method!("hostList.removeDecorations", ["hosts.read", "workspace.write"], "{id:string}", "Remove only this plugin runtime's host decoration collection; returns false if absent. Requires the same permissions as registration."),
    stable_method!("tabBar.set", [], "{id:string,title:string,kind:button|select|text,priority?:number,icon?:string,command?:string,disabled?:boolean,when?:{tabKind?:string,tabId?:string},options?:{value:string,label:string}[],value?:string,placement?:leading|trailing,group?:string,tooltip?:string,showLabel?:boolean,checked?:boolean}", "Register or replace a bounded declarative tab-bar control owned by this runtime. Defaults to own plugin views and trailing placement; when:{} targets all tabs. Groups are plugin-scoped. showLabel keeps button text alongside its icon; checked is button-only, host-rendered, and acknowledged through set. Narrow panes move controls into an accessible overflow menu. Commands must belong to this plugin. Eight items per plugin, 128 total; removed on stop or revocation. Click context is advisory, never authorization.", "0.32.0-beta.6"),
    stable_method!("tabBar.remove", [], "{id:string}", "Remove this runtime's tab-bar control; return false if absent. IDs are scoped to the plugin and runtime generation.", "0.32.0-beta.6"),
    stable_method!("statusBar.set", [], "{id:string,text:string,alignment?:left|right,priority?:number,tooltip?:string,icon?:activity|check|alert|info|sync|terminal|cloud|code|plug,command?:string}", "Register or replace this runtime's status item. Eight per plugin, 128 total; plain text only. Click commands must be this plugin's non-editor, non-file-menu manifest commands. Items disappear on stop, revocation, crash or restart.", "0.32.0-beta.1"),
    stable_method!("statusBar.remove", [], "{id:string}", "Remove this runtime's status item; return false when absent. IDs are scoped to the plugin and runtime generation.", "0.32.0-beta.1"),
    stable_method!("editor.active", ["editor.read"], "{}", "Read the active ready editor document or null. Returns tabId, documentId, version, path, name, content and dirty. Maximum UTF-8 content 128KiB. Does not read files from disk.", "0.29.0-beta.2"),
    stable_method!("editor.replace", ["editor.write"], "{tabId:string,documentId:string,version:number,text:string}", "Replace an open editor buffer only if the document identity and version still match. Maximum UTF-8 text 128KiB. Undoable; never saves automatically. Rejects stale, closed, loading or disconnected documents.", "0.29.0-beta.2"),
    method!("mounts.browse", ["mounts.read"], "{sessionId:string,path?:string}", "Browse directories through an authenticated SFTP session for the mount chooser."),
    method!("mounts.open", ["mounts.write"], "{id:string}", "Open this plugin's mount in the system file manager."),
    method!("mounts.documentation", ["mounts.read"], "{}", "Open platform SSHFS installation instructions in the system browser."),
    method!("mounts.dependencies", ["mounts.read"], "{}", "Detect SSHFS and FUSE compatibility; never install software or drivers."),
    method!("mounts.list", ["mounts.read"], "{}", "List this plugin's own SSHFS mounts."),
    method!("mounts.mount", ["mounts.write"], "{sessionId:string,remotePath:string,mountPoint:string,readOnly?:boolean}", "Mount using an authenticated SSH subsystem and the host's proxy/jump route. Defaults read-only."),
    method!("mounts.unmount", ["mounts.write"], "{id:string,force?:boolean}", "Unmount this plugin's own SSHFS filesystem; never terminate unrelated processes."),
    method!("forwards.list", ["forwards.read"], "{}", "Read saved TCP forwarding rules and running status."),
    method!("forwards.save", ["forwards.write"], "{rule:ForwardRule}", "Create or update a validated TCP forwarding rule; active rules must be stopped first."),
    method!("forwards.remove", ["forwards.write"], "{id:string}", "Remove a saved forwarding rule and stop its active connections."),
    method!("forwards.start", ["forwards.write"], "{id:string,sessionId:string}", "Start a saved forward through its host's active authenticated session; stopped on plugin revocation."),
    method!("forwards.stop", ["forwards.write"], "{id:string}", "Stop a forwarding listener and its active connections."),
    method!("runners.deploy", ["ssh.exec", "fs.read", "sftp.write"], "{sessionId:string,platform:posix|windows,directory:string,runnerPath:string,executable:string}", "After explicit confirmation, deploy an optional selected native helper and this plugin into a fresh user directory. Never install Node or modify services."),
    method!("runners.start", ["ssh.exec"], "{sessionId:string,directory:string,config:object,secrets?:object}", "Start a durable plugin runner using a previously approved deployment; secrets travel over SSH stdin, not files or argv."),
    method!("runners.list", ["ssh.exec"], "{}", "Read this plugin's durable runner records, including stopPending for unreachable revoked tasks."),
    method!("runners.send", ["ssh.exec"], "{sessionId:string,runnerId:string,message:object}", "Enqueue an RPC request or approval response for this plugin's own remote runner."),
    method!("runners.poll", ["ssh.exec"], "{sessionId:string,runnerId:string,afterSeq?:number}", "Read sequenced durable runner events and pending approvals after reconnect."),
    method!("runners.status", ["ssh.exec"], "{sessionId:string,runnerId:string}", "Read this plugin's remote runner status."),
    method!("runners.stop", ["ssh.exec"], "{sessionId:string,runnerId:string}", "Persist and request stopping a remote runner; does not claim that an unreachable process has stopped."),
    stable_method!("events.publish", [], "{event:string,payload?:JSON}", "Emit an advisory UI event from the current approved runtime. Event names use 1-128 ASCII letters, digits, dot, underscore, colon or hyphen. Omitted payload becomes null; extra fields cannot replace host-supplied pluginId/generation. Shared 256KiB UTF-8 request budget. Return null on transport acceptance, not subscriber acknowledgement or durable delivery. No replay, cross-request completion order or permission grant is promised; consumers must check runtime generation.", "0.21.0"),
    method!("secrets.get", ["secrets"], "{key:string}", "Read this plugin's own OS-keyring secret; return string or null. Never exposes SSH credentials."),
    method!("secrets.set", ["secrets"], "{key:string,value:string}", "Store this plugin's own secret in the operating system keyring, at most 16KiB."),
    method!("secrets.delete", ["secrets"], "{key:string}", "Delete this plugin's own keyring secret."),
    method!("tasks.start", [], "{executable:string,args?:string[],cwd?:string,sessionId?:string,platform?:posix|windows,timeoutMs?:number}", "Start an explicitly selected executable; requires process.exec locally or ssh.exec remotely. Return taskId. Separate bounded stdout/stderr; default 30 minutes, maximum 24 hours."),
    method!("tasks.list", [], "{}", "List this runtime's own background processes."),
    method!("tasks.status", [], "{taskId:string}", "Read this runtime's own process status and exit code."),
    method!("tasks.readOutput", [], "{taskId:string,afterSeq?:number}", "Read bounded sequenced stdout/stderr events; truncated reports expired output."),
    method!("tasks.write", [], "{taskId:string,data:string}", "Write UTF-8 to this runtime's own process stdin; at most 128KiB."),
    method!("tasks.closeInput", [], "{taskId:string}", "Close this runtime's own process stdin."),
    method!("tasks.cancel", [], "{taskId:string}", "Stop this runtime's own process; local process trees are terminated, remote server signal support may vary."),
    method!("tools.invoke", [], "{method:string,params:object,mode:ask|approve|full|readOnly,scope:{sessionIds?:string[],hostIds?:string[],localRoots?:string[],remoteRoots?:{sessionId:string,path:string}[]},review?:{approved:boolean,reason:string},clientId?:string,requestId?:string}", "Execute an allowlisted AI/MCP tool after permission, target scope and approval checks. ReadOnly rejects every command and mutation. Review may only be supplied by a trusted plugin's independent reviewer."),
    method!("tools.cancel", [], "{requestId:string}", "Cancel this plugin runtime's pending tool invocation; already completed operations cannot be rolled back."),
    method!("tools.revokeClient", [], "{clientId:string}", "Cancel pending tool invocations owned by this plugin runtime's client."),
    stable_method!("api.describe", [], "{}", "List the fixed versioned host API; every request still checks runtime authorization.", "0.21.0"),
    stable_method!("log", ["log"], "{message:string,level?:string,domain?:string,operation?:string,requestId?:string,fields?:object}", "Write a bounded local log at its requested severity; return null on acceptance, not durable delivery. Host supplies plugin identity and runtime generation; domain is plugin-scoped. Optional structured fields redact credential keys and URL credentials/query/fragment. Existing message/level calls remain supported; structured options require 0.33.0-beta.5 or later. Subject to configured log filter and nonblocking writer; never include secrets in message text.", "0.21.0"),
    method!("app.info", ["app.read"], "{}", "Read application metadata, platform and preference schema; no credentials."),
    method!("app.openExternal", ["app.openExternal"], "{url:string}", "Open an http/https URL with the system browser."),
    method!("settings.get", ["settings.read"], "{}", "Read application preferences."),
    method!("settings.update", ["settings.write"], "{patch:object}", "Update and sanitize preferences through the normal settings service."),
    method!("hosts.snapshot", ["hosts.read"], "{}", "Read saved host and group metadata; authentication secrets are never returned."),
    method!("hosts.create", ["hosts.write"], "{input:HostInput}", "Create a validated saved host."),
    method!("hosts.update", ["hosts.write"], "{id:string,input:HostInput}", "Replace a saved host's validated metadata."),
    method!("hosts.delete", ["hosts.write"], "{id:string}", "Delete a saved host and forget its stored credential."),
    method!("hosts.markUsed", ["hosts.write"], "{id:string}", "Update a saved host's last-used time."),
    method!("hosts.reorder", ["hosts.write"], "{ids:string[]}", "Persist the order of saved hosts; at most 500 IDs."),
    method!("groups.create", ["hosts.write"], "{input:GroupInput}", "Create a validated host group."),
    method!("groups.update", ["hosts.write"], "{id:string,input:GroupInput}", "Update a validated host group."),
    method!("groups.delete", ["hosts.write"], "{id:string}", "Delete a host group through the normal group service."),
    stable_method!("sessions.list", ["sessions.read"], "{}", "List active SSH session metadata; no passwords or private keys.", "0.21.0"),
    method!("sessions.connect", ["ssh.exec"], "{request:SshConnectRequest}", "Connect a saved host with normal host-key verification; never auto-trust a server."),
    method!("sessions.disconnect", ["ssh.exec"], "{sessionId:string}", "Disconnect an active SSH session."),
    method!("sessions.exec", ["ssh.exec"], "{sessionId:string,command:string,timeoutMs?:number}", "Execute in a separate SSH channel; return stdout/stderr/exitCode/signal. Timeout 100–60000ms, output at most 1MiB."),
    method!("terminal.write", ["ssh.exec"], "{sessionId:string,data:string}", "Write plain UTF-8 terminal input, including remote shell commands; the host handles transport encoding."),
    method!("terminal.resize", ["ssh.exec"], "{sessionId:string,cols:number,rows:number}", "Resize the remote terminal through the validated session service."),
    method!("files.local.home", ["fs.read"], "{}", "Read the local home directory path."),
    method!("files.local.list", ["fs.read"], "{path?:string}", "List a local directory."),
    method!("files.local.readText", ["fs.read"], "{path:string}", "Read a UTF-8 local text file, at most 512KiB; reject binary data."),
    method!("files.local.writeText", ["fs.write"], "{path:string,content:string,baseline?:string}", "Atomically replace existing local UTF-8 text, at most 512KiB; optional baseline detects external edits."),
    method!("files.local.createFile", ["fs.write"], "{path:string}", "Create an empty local file without replacing an existing file."),
    method!("files.local.mkdir", ["fs.write"], "{path:string}", "Create a local directory."),
    method!("files.local.rename", ["fs.write"], "{from:string,to:string,overwrite?:boolean}", "Rename a local file or directory; overwriting is opt-in."),
    method!("files.local.copy", ["fs.read", "fs.write"], "{from:string,to:string,overwrite?:boolean}", "Copy local files/directories through the existing copy service."),
    method!("files.local.delete", ["fs.write"], "{path:string,isDir:boolean}", "Delete a local file or directory."),
    method!("files.sftp.list", ["sftp.read"], "{sessionId:string,path?:string}", "List a remote directory using an active SSH session."),
    method!("files.sftp.resolveDirectory", ["sftp.read"], "{sessionId:string,path?:string}", "Resolve the SSH account home and an optional working directory through SFTP without listing entries or executing a shell. Return {home,path}. Supports ~ and relative paths."),
    method!("files.sftp.readText", ["sftp.read"], "{sessionId:string,path:string}", "Read remote UTF-8 text through the editor service; API response size limits apply."),
    method!("files.sftp.writeText", ["sftp.write"], "{sessionId:string,path:string,content:string,baseline?:string}", "Atomically replace existing remote text; optional baseline detects external edits."),
    method!("files.sftp.createFile", ["sftp.write"], "{sessionId:string,path:string}", "Create an empty remote file without replacing an existing file."),
    method!("files.sftp.mkdir", ["sftp.write"], "{sessionId:string,path:string}", "Create a remote directory."),
    method!("files.sftp.rename", ["sftp.write"], "{sessionId:string,from:string,to:string,overwrite?:boolean}", "Rename a remote file/directory; overwriting is opt-in."),
    method!("files.sftp.copy", ["sftp.read", "sftp.write"], "{sessionId:string,from:string,to:string,overwrite?:boolean}", "Copy remote files/directories within a session."),
    method!("files.sftp.delete", ["sftp.write"], "{sessionId:string,path:string,isDir:boolean}", "Delete a remote file or directory."),
    method!("files.upload", ["fs.read", "sftp.write"], "{sessionId:string,localPath:string,remotePath:string,overwrite?:boolean}", "Copy a local file or directory to a remote path. Return transferId; cancellation, progress and file refresh use the normal transfer service. Revoking access or stopping this runtime cancels its active transfers."),
    method!("files.download", ["sftp.read", "fs.write"], "{sessionId:string,remotePath:string,localPath:string,overwrite?:boolean}", "Copy a remote file or directory to a local path. Return transferId; never remove the source. Revoking access or stopping this runtime cancels its active transfers."),
    method!("files.cancelTransfer", [], "{transferId:string}", "Cancel only a transfer owned by this plugin's current runtime. Return true if its active transfer was found; false for completed, missing or other owners' transfers."),
    method!("files.transferStatus", [], "{transferId:string}", "Read progress or the final TransferEvent for this runtime's own transfer; return null for missing, other-owner or expired IDs. The latest 256 completed plugin transfers are retained in memory."),
    method!("monitor.system", ["monitor.read"], "{}", "Read local CPU, memory, disk and network statistics."),
    method!("monitor.stats", ["monitor.read"], "{sessionId:string}", "Sample remote system statistics."),
    method!("monitor.processes", ["monitor.read"], "{sessionId:string}", "List remote processes."),
    method!("monitor.kill", ["monitor.write"], "{sessionId:string,pid:number}", "Send TERM to a remote process; protected process validation still applies."),
    method!("history.list", ["history.read"], "{hostId:string,limit?:number}", "Read saved command history, at most 500 rows."),
    method!("history.record", ["history.write"], "{hostId:string,command:string}", "Record a command for an existing saved host."),
    method!("history.delete", ["history.write"], "{id:number}", "Delete one command-history entry."),
    method!("history.clear", ["history.write"], "{hostId:string}", "Clear a saved host's command history."),
    stable_method!("workspace.snapshot", ["workspace.read"], "{}", "Read a detached v1 snapshot of live tabs, panes, active IDs and split layout, including hidden panels and file-pane metadata. No file contents, credentials or arbitrary store fields. Tab kinds and file-view option values are open vocabularies; tolerate unfamiliar values. The snapshot neither reserves resources nor grants their permissions.", "0.21.0"),
    method!("workspace.openPage", ["workspace.write"], "{kind:welcome|settings|about|updates|knownHosts}", "Open or focus an existing application page."),
    method!("workspace.openHost", ["workspace.write", "hosts.read"], "{hostId:string}", "Open a saved host's details; never reveal an authentication secret."),
    method!("workspace.openTerminal", ["workspace.write", "sessions.read"], "{sessionId:string}", "Open a terminal tab for an already-connected session."),
    method!("workspace.openFiles", ["workspace.write", "sessions.read"], "{sessionId:string}", "Open a file browser for an already-connected session."),
    method!("workspace.openSidebar", ["workspace.write"], "{view:hosts|plugins|knownHosts}", "Dock a list into the current workspace group."),
    method!("workspace.activate", ["workspace.write"], "{tabId:string}", "Activate an existing tab and its group."),
    method!("workspace.close", ["workspace.write"], "{tabId:string}", "Close a tab; dirty editors retain the normal user confirmation. Result reports pending confirmation."),
    method!("workspace.split", ["workspace.write"], "{tabId:string,direction:row|column,position?:before|after,targetPaneId?:string}", "Move a tab into a split group."),
    method!("workspace.move", ["workspace.write"], "{tabId:string,paneId:string,beforeTabId?:string|null}", "Move or reorder an existing tab."),
    method!("workspace.showQuickAccess", ["workspace.write"], "{query?:string}", "Open Quick Access with an optional query. Never execute a command automatically."),
    method!("workspace.setPaneLocked", ["workspace.write"], "{paneId:string,locked:boolean}", "Set the destination lock on an existing pane."),
    method!("workspace.resizeSplit", ["workspace.write"], "{splitId:string,ratio:number}", "Resize an existing split with a ratio between 0.1 and 0.9."),
    method!("workspace.returnSidebar", ["workspace.write"], "{view:hosts|plugins|knownHosts}", "Return a docked list to the sidebar."),
    method!("clipboard.readText", ["clipboard.read"], "{}", "Read the system text clipboard."),
    method!("clipboard.writeText", ["clipboard.write"], "{text:string}", "Replace the system text clipboard."),
    stable_method!("storage.get", [], "{key:string}", "Read plugin-scoped JSON data. Keys use 1–128 ASCII letters, digits, dot, hyphen or underscore.", "0.21.0"),
    stable_method!("storage.set", [], "{key:string,value:JSON}", "Persist plugin-scoped JSON data, at most 256KiB total per plugin.", "0.21.0"),
    stable_method!("storage.delete", [], "{key:string}", "Remove a key from plugin-scoped JSON data.", "0.21.0"),
    stable_method!("ui.showMessage", [], "{message:string,kind?:info|success|error}", "Show a bounded plain-text notification prefixed with the installed plugin's identity. Returns null on acceptance, not durable delivery. Nonempty message, no NUL, at most 4000 UTF-16 units. Omitted/null kind defaults to info. No events or actions; notifications may expire or be displaced.", "0.21.0"),
    stable_method!("ui.confirm", [], "{message:string}", "Ask a plugin-identified plain-text confirmation without replacing an existing dialog. Returns true only on confirmation; dismiss, replacement or 55-second UI timeout returns false. Nonempty message, no NUL, at most 220Ki UTF-16 units and the shared 256KiB wire budget. Concurrent dialogs reject as busy; stopped/revoked/cancelled runtimes do not receive approval. No additional permissions are granted.", "0.21.0"),
];

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
        "forwards.list" => encode(crate::ssh::forward::list(app)?),
        "forwards.save" => encode(crate::ssh::forward::save(app, field(&params, "rule")?)?),
        "forwards.remove" => {
            crate::ssh::forward::remove(app, &field::<String>(&params, "id")?)?;
            Ok(Value::Null)
        }
        "forwards.start" => {
            let lease = super::security::Lease {
                id: context.id.clone(),
                fingerprint: context.fingerprint.clone(),
                permissions: context.permissions.clone(),
                generation: context.generation,
            };
            let result = state
                .plugins
                .security
                .guard(
                    &lease,
                    crate::ssh::forward::start_owned(
                        app,
                        &field::<String>(&params, "id")?,
                        &field::<String>(&params, "sessionId")?,
                        Some((context.id.clone(), context.generation)),
                    ),
                )
                .await;
            if let Err(error) = authorize(context, &["forwards.write"]) {
                state
                    .forwards
                    .stop_generation(&context.id, context.generation);
                return Err(error);
            }
            result?;
            Ok(Value::Null)
        }
        "forwards.stop" => {
            state
                .forwards
                .stop(&field::<String>(&params, "id")?)
                .await?;
            Ok(Value::Null)
        }
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
            encode(commands::settings_update(app.clone(), state, patch)?)
        }
        "hosts.snapshot" => encode(crate::services::hosts::snapshot(&state.db)?),
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
            commands::ssh_connect(app.clone(), field(&params, "request")?).await?,
        )),
        "sessions.disconnect" => {
            commands::ssh_disconnect(app.clone(), field(&params, "sessionId")?)?;
            Ok(Value::Null)
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
            state,
            field(&params, "hostId")?,
            optional(&params, "limit")?,
        )?),
        "history.record" => encode(commands::history_record(
            state,
            field(&params, "hostId")?,
            field(&params, "command")?,
        )?),
        "history.delete" => {
            commands::history_delete(state, field(&params, "id")?)?;
            Ok(Value::Null)
        }
        "history.clear" => {
            commands::history_clear(state, field(&params, "hostId")?)?;
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
        "sessions.connect" | "sessions.disconnect" => Some("sessions"),
        "history.record" | "history.delete" | "history.clear" => Some("history"),
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
    let entry =
        method_info(method).ok_or_else(|| AppError::validation("plugin.api.unknownMethod"))?;
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
                permissions: entry.permissions,
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
            Duration::from_secs(if method == "ui.confirm" { 60 } else { 15 }),
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
        for entry in METHODS {
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
