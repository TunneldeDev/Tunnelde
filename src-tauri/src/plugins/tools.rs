//! Scoped tool gateway shared by MCP clients and agent plugins.
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::Manager;
use tokio::sync::oneshot;

use super::api::{authorize, field, frontend_request, HostContext};
use crate::error::{AppError, AppResult};
use crate::state::AppState;

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Scope {
    #[serde(default)]
    session_ids: Vec<String>,
    #[serde(default)]
    host_ids: Vec<String>,
    #[serde(default)]
    local_roots: Vec<String>,
    #[serde(default)]
    remote_roots: Vec<RemoteRoot>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RemoteRoot {
    session_id: String,
    path: String,
}

fn validate_scope(scope: &Scope) -> AppResult<()> {
    let valid_id = |id: &String| !id.is_empty() && id.len() <= 128 && !id.contains('\0');
    let valid_path =
        |path: &String| !path.is_empty() && path.len() <= 32768 && !path.contains('\0');
    if scope.session_ids.len() > 64
        || scope.host_ids.len() > 64
        || scope.local_roots.len() > 64
        || scope.remote_roots.len() > 64
        || !scope.session_ids.iter().all(valid_id)
        || !scope.host_ids.iter().all(valid_id)
        || !scope.local_roots.iter().all(valid_path)
        || !scope
            .remote_roots
            .iter()
            .all(|root| valid_id(&root.session_id) && valid_path(&root.path))
    {
        return Err(AppError::validation("plugin.tools.invalidScope"));
    }
    Ok(())
}

fn read_only(method: &str) -> bool {
    matches!(
        method,
        "hosts.snapshot"
            | "sessions.list"
            | "files.local.home"
            | "files.local.list"
            | "files.local.readText"
            | "files.sftp.list"
            | "files.sftp.readText"
            | "files.transferStatus"
            | "tasks.status"
            | "tasks.readOutput"
            | "tasks.list"
    )
}
fn allowed(method: &str) -> bool {
    read_only(method)
        || matches!(
            method,
            "sessions.connect"
                | "sessions.disconnect"
                | "sessions.exec"
                | "files.local.writeText"
                | "files.local.createFile"
                | "files.local.mkdir"
                | "files.local.rename"
                | "files.local.copy"
                | "files.local.delete"
                | "files.sftp.writeText"
                | "files.sftp.createFile"
                | "files.sftp.mkdir"
                | "files.sftp.rename"
                | "files.sftp.copy"
                | "files.sftp.delete"
                | "files.upload"
                | "files.download"
                | "files.cancelTransfer"
                | "tasks.start"
                | "tasks.cancel"
        )
}

fn canonical_target(path: &Path) -> AppResult<PathBuf> {
    if !path.is_absolute() {
        return Err(AppError::validation("plugin.tools.absolutePathRequired"));
    }
    // Resolve existing targets (including symlinks). New targets must have an existing parent.
    match std::fs::canonicalize(path) {
        Ok(path) => Ok(path),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let name = path
                .file_name()
                .ok_or_else(|| AppError::validation("plugin.tools.invalidPath"))?;
            let parent = std::fs::canonicalize(
                path.parent()
                    .ok_or_else(|| AppError::validation("plugin.tools.invalidPath"))?,
            )?;
            Ok(parent.join(name))
        }
        Err(error) => Err(error.into()),
    }
}
fn local_path(path: &str, roots: &[String]) -> AppResult<String> {
    let target = canonical_target(Path::new(path))?;
    for root in roots {
        let root = std::fs::canonicalize(root)?;
        if target.starts_with(&root) {
            return Ok(target.to_string_lossy().into_owned());
        }
    }
    Err(AppError::validation("plugin.tools.outsideScope"))
}
fn remote_within(path: &str, root: &str) -> bool {
    let root = root.trim_end_matches('/');
    path == root || (path.starts_with(root) && path.as_bytes().get(root.len()) == Some(&b'/'))
}
async fn remote_path(
    context: &HostContext,
    session: &str,
    path: &str,
    roots: &[RemoteRoot],
) -> AppResult<String> {
    if !path.starts_with('/') || path.contains('\0') || path.split('/').any(|part| part == "..") {
        return Err(AppError::validation("plugin.tools.absolutePathRequired"));
    }
    let sftp = crate::ssh::files::session(&context.app, session).await?;
    let target = match sftp.canonicalize(path).await {
        Ok(path) => path,
        Err(_) => {
            // Only missing entries can resolve via their parent; errors on existing links fail closed.
            match sftp.symlink_metadata(path).await {
                Err(russh_sftp::client::error::Error::Status(status))
                    if status.status_code == russh_sftp::protocol::StatusCode::NoSuchFile => {}
                _ => return Err(AppError::validation("plugin.tools.pathResolutionFailed")),
            }
            let (parent, name) = path
                .rsplit_once('/')
                .ok_or_else(|| AppError::validation("plugin.tools.invalidPath"))?;
            if name.is_empty() || name == "." || name == ".." {
                return Err(AppError::validation("plugin.tools.invalidPath"));
            }
            let parent = sftp
                .canonicalize(if parent.is_empty() { "/" } else { parent })
                .await
                .map_err(|error| AppError::Ssh(error.to_string()))?;
            format!("{}/{name}", parent.trim_end_matches('/'))
        }
    };
    for root in roots.iter().filter(|root| root.session_id == session) {
        let root = sftp
            .canonicalize(&root.path)
            .await
            .map_err(|error| AppError::Ssh(error.to_string()))?;
        if remote_within(&target, &root) {
            return Ok(target);
        }
    }
    Err(AppError::validation("plugin.tools.outsideScope"))
}

async fn scoped(
    context: &HostContext,
    method: &str,
    params: &Value,
    scope: &Scope,
) -> AppResult<Value> {
    let mut params = params.clone();
    let session = params
        .get("sessionId")
        .and_then(Value::as_str)
        .map(str::to_owned);
    if let Some(session) = &session {
        if !scope.session_ids.contains(session) {
            return Err(AppError::validation("plugin.tools.outsideScope"));
        }
    }
    if method == "sessions.connect" {
        let host = params
            .pointer("/request/hostId")
            .and_then(Value::as_str)
            .ok_or_else(|| AppError::validation("plugin.tools.hostRequired"))?;
        if !scope.host_ids.iter().any(|id| id == host) {
            return Err(AppError::validation("plugin.tools.outsideScope"));
        }
        // Secrets may only be supplied by Tunnelde's established connection UI/vault.
        if let Some(request) = params.get_mut("request").and_then(Value::as_object_mut) {
            request.remove("password");
            request.remove("passphrase");
        }
    }
    let keys: &[&str] = if method.starts_with("files.local.") || method.starts_with("files.sftp.") {
        if method.ends_with(".rename") || method.ends_with(".copy") {
            &["from", "to"]
        } else if method.ends_with(".home") {
            &[]
        } else {
            &["path"]
        }
    } else if method == "files.upload" || method == "files.download" {
        &["localPath", "remotePath"]
    } else if method == "tasks.start" {
        &["cwd"]
    } else {
        &[]
    };
    for key in keys {
        let path = params
            .get(*key)
            .and_then(Value::as_str)
            .ok_or_else(|| AppError::validation("plugin.tools.explicitPathRequired"))?;
        let remote = method.starts_with("files.sftp.")
            || *key == "remotePath"
            || (method == "tasks.start" && session.is_some());
        let normalized = if remote {
            remote_path(
                context,
                session
                    .as_deref()
                    .ok_or_else(|| AppError::validation("plugin.tools.sessionRequired"))?,
                path,
                &scope.remote_roots,
            )
            .await?
        } else {
            local_path(path, &scope.local_roots)?
        };
        params[*key] = json!(normalized);
    }
    if method == "sessions.exec" && session.is_none() {
        return Err(AppError::validation("plugin.tools.sessionRequired"));
    }
    Ok(params)
}

struct Pending {
    registration: uuid::Uuid,
    plugin: String,
    generation: u64,
    client: String,
    cancel: oneshot::Sender<()>,
}
#[derive(Clone)]
struct Resource {
    plugin: String,
    generation: u64,
    client: String,
    id: String,
    transfer: bool,
}
fn resources() -> &'static Mutex<Vec<Resource>> {
    static RESOURCES: OnceLock<Mutex<Vec<Resource>>> = OnceLock::new();
    RESOURCES.get_or_init(|| Mutex::new(Vec::new()))
}
pub(super) fn register_resource(context: &HostContext, id: &str, transfer: bool) -> bool {
    let Some(client) = &context.tool_client else {
        return true;
    };
    let mut items = resources()
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    items.retain(|item| item.plugin != context.id || item.generation == context.generation);
    if items.len() >= 4096
        || items.iter().any(|item| {
            item.plugin == context.id
                && item.generation == context.generation
                && item.client == *client
                && item.id.is_empty()
        })
    {
        return false;
    }
    items.push(Resource {
        plugin: context.id.clone(),
        generation: context.generation,
        client: client.clone(),
        id: id.into(),
        transfer,
    });
    true
}
fn pending() -> &'static Mutex<HashMap<String, Pending>> {
    static PENDING: OnceLock<Mutex<HashMap<String, Pending>>> = OnceLock::new();
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}
// Registration and revocation must share one linearization point. Resource
// registration separately checks the tombstone while holding the resource lock.
fn client_gate() -> &'static Mutex<()> {
    static GATE: OnceLock<Mutex<()>> = OnceLock::new();
    GATE.get_or_init(|| Mutex::new(()))
}
fn client_revoked(plugin: &str, generation: u64, client: &str) -> bool {
    resources()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .iter()
        .any(|item| {
            item.plugin == plugin
                && item.generation == generation
                && item.client == client
                && item.id.is_empty()
        })
}
fn register_pending(key: &str, request: Pending) -> AppResult<()> {
    let _gate = client_gate()
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    if client_revoked(&request.plugin, request.generation, &request.client) {
        return Err(AppError::validation("plugin.tools.clientRevoked"));
    }
    let mut requests = pending().lock().unwrap_or_else(|error| error.into_inner());
    if requests.len() >= 256 || requests.contains_key(key) {
        return Err(AppError::validation("plugin.tools.busy"));
    }
    requests.insert(key.to_owned(), request);
    Ok(())
}
fn cancel_pending(
    plugin: &str,
    generation: u64,
    target: &str,
    method: &str,
) -> (usize, Vec<Resource>) {
    let key = format!("{}:{}:{}", plugin, generation, target);
    let (count, owned) = {
        let _gate = client_gate()
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let mut requests = pending().lock().unwrap_or_else(|e| e.into_inner());
        let ids: Vec<_> = requests
            .iter()
            .filter(|(id, request)| {
                request.plugin == plugin
                    && request.generation == generation
                    && (if method == "tools.cancel" {
                        **id == key
                    } else {
                        request.client == target
                    })
            })
            .map(|(id, _)| id.clone())
            .collect();
        let count = ids.len();
        for id in ids {
            if let Some(request) = requests.remove(&id) {
                let _ = request.cancel.send(());
            }
        }
        let owned = if method == "tools.revokeClient" {
            let mut items = resources()
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            let owned: Vec<_> = items
                .iter()
                .filter(|item| {
                    item.plugin == plugin
                        && item.generation == generation
                        && item.client == target
                        && !item.id.is_empty()
                })
                .cloned()
                .collect();
            items.retain(|item| {
                !(item.plugin == plugin && item.generation == generation && item.client == target)
            });
            items.push(Resource {
                plugin: plugin.to_owned(),
                generation,
                client: target.to_owned(),
                id: String::new(),
                transfer: false,
            });
            owned
        } else {
            Vec::new()
        };
        (count, owned)
    };
    (count, owned)
}
struct PendingGuard(String, uuid::Uuid);
impl Drop for PendingGuard {
    fn drop(&mut self) {
        let mut requests = pending().lock().unwrap_or_else(|e| e.into_inner());
        if requests
            .get(&self.0)
            .is_some_and(|request| request.registration == self.1)
        {
            requests.remove(&self.0);
        }
    }
}

pub async fn invoke(context: &HostContext, params: Value) -> AppResult<Value> {
    let request_id = params
        .get("requestId")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let client = params
        .get("clientId")
        .and_then(Value::as_str)
        .unwrap_or("agent")
        .to_owned();
    if request_id.is_empty() || client.is_empty() || request_id.len() > 128 || client.len() > 128 {
        return Err(AppError::validation("plugin.tools.invalidIdentity"));
    }
    let key = format!("{}:{}:{}", context.id, context.generation, request_id);
    let (sender, cancel) = oneshot::channel();
    let registration = uuid::Uuid::new_v4();
    register_pending(
        &key,
        Pending {
            registration,
            plugin: context.id.clone(),
            generation: context.generation,
            client,
            cancel: sender,
        },
    )?;
    let _guard = PendingGuard(key, registration);
    tokio::select! {
        biased;
        _ = cancel => Err(AppError::validation("plugin.tools.cancelled")),
        result = invoke_inner(context, params) => result,
    }
}
pub async fn cancel(context: &HostContext, method: &str, params: &Value) -> AppResult<Value> {
    let target: String = field(
        params,
        if method == "tools.cancel" {
            "requestId"
        } else {
            "clientId"
        },
    )?;
    if target.is_empty() || target.len() > 128 {
        return Err(AppError::validation("plugin.tools.invalidIdentity"));
    }
    let (count, owned) = cancel_pending(&context.id, context.generation, &target, method);
    if method == "tools.revokeClient" {
        for item in owned {
            if item.transfer {
                let _ = Box::pin(super::api::dispatch(
                    context,
                    "files.cancelTransfer",
                    json!({"transferId":item.id}),
                ))
                .await;
            } else {
                let _ = super::tasks::dispatch(context, "tasks.cancel", json!({"taskId":item.id}))
                    .await;
            }
        }
    }
    Ok(json!({"cancelled":count}))
}

async fn invoke_inner(context: &HostContext, params: Value) -> AppResult<Value> {
    let method: String = field(&params, "method")?;
    let mode: String = field(&params, "mode")?;
    let input: Value = field(&params, "params")?;
    let client = params
        .get("clientId")
        .and_then(Value::as_str)
        .unwrap_or("agent");
    let scope: Scope = serde_json::from_value(field(&params, "scope")?)
        .map_err(|_| AppError::validation("plugin.tools.invalidScope"))?;
    validate_scope(&scope)?;
    if !allowed(&method)
        || !input.is_object()
        || !matches!(mode.as_str(), "ask" | "approve" | "full" | "readOnly")
    {
        return Err(AppError::validation("plugin.tools.unsupported"));
    }
    if mode == "readOnly" && !read_only(&method) {
        return Err(AppError::validation("plugin.tools.readOnly"));
    }
    let entry = super::api::method_info(&method)
        .ok_or_else(|| AppError::validation("plugin.tools.unsupported"))?;
    authorize(context, entry.permissions)?;
    if method.starts_with("tasks.") && method != "tasks.start" && method != "tasks.list"
        || method == "files.transferStatus"
        || method == "files.cancelTransfer"
    {
        let id = input
            .get(if method.starts_with("tasks.") {
                "taskId"
            } else {
                "transferId"
            })
            .and_then(Value::as_str)
            .ok_or_else(|| AppError::validation("plugin.tools.resourceRequired"))?;
        if !resources()
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .iter()
            .any(|item| {
                item.plugin == context.id
                    && item.generation == context.generation
                    && item.client == client
                    && item.id == id
            })
        {
            return Err(AppError::validation("plugin.tools.outsideScope"));
        }
    }
    let normalized = scoped(context, &method, &input, &scope).await?;
    let original_hash = if method.ends_with(".writeText") {
        let read_method = if method.starts_with("files.local.") {
            "files.local.readText"
        } else {
            "files.sftp.readText"
        };
        let original = Box::pin(super::api::dispatch(
            context,
            read_method,
            normalized.clone(),
        ))
        .await?;
        let hash = format!(
            "{:x}",
            Sha256::digest(original["content"].as_str().unwrap_or_default().as_bytes())
        );
        if normalized
            .get("expectedHash")
            .and_then(Value::as_str)
            .is_some_and(|expected| expected != hash)
        {
            return Err(AppError::validation("plugin.tools.fileChanged"));
        }
        Some((read_method, hash))
    } else {
        None
    };
    let auto_review = params.pointer("/review/approved").and_then(Value::as_bool) == Some(true);
    if !read_only(&method) && mode != "full" && !(mode == "approve" && auto_review) {
        let description = serde_json::to_string_pretty(&normalized)?;
        if description.len() > 200 * 1024 {
            return Err(AppError::validation("plugin.tools.approvalTooLarge"));
        }
        let message = format!("AI / MCP: {method}\n\n{description}");
        let approved = frontend_request(context, "ui.confirm", json!({"message":message})).await?;
        if approved.as_bool() != Some(true) {
            return Err(AppError::validation("plugin.tools.denied"));
        }
    }
    // Re-resolve after approval, rejecting moved links and changed targets.
    let rechecked = scoped(context, &method, &input, &scope).await?;
    if rechecked != normalized {
        return Err(AppError::validation("plugin.tools.targetChanged"));
    }
    if let Some((read_method, hash)) = original_hash {
        let current = Box::pin(super::api::dispatch(
            context,
            read_method,
            normalized.clone(),
        ))
        .await?;
        if format!(
            "{:x}",
            Sha256::digest(current["content"].as_str().unwrap_or_default().as_bytes())
        ) != hash
        {
            return Err(AppError::validation("plugin.tools.fileChanged"));
        }
    }
    let mut invocation_context = context.clone();
    if client_revoked(&context.id, context.generation, client) {
        return Err(AppError::validation("plugin.tools.clientRevoked"));
    }
    invocation_context.tool_client = Some(client.into());
    let mut result = Box::pin(super::api::dispatch(
        &invocation_context,
        &method,
        normalized,
    ))
    .await?;
    if method.ends_with(".readText") {
        if let Some(content) = result.get("content").and_then(Value::as_str) {
            let hash = format!("{:x}", Sha256::digest(content.as_bytes()));
            result["sha256"] = json!(hash);
        }
    }
    if method == "tasks.list" {
        if let Some(tasks) = result.as_array_mut() {
            let items = resources()
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            tasks.retain(|task| {
                task["taskId"].as_str().is_some_and(|id| {
                    items.iter().any(|item| {
                        item.plugin == context.id
                            && item.generation == context.generation
                            && item.client == client
                            && item.id == id
                    })
                })
            });
        }
    }
    if method == "sessions.list" {
        if let Some(sessions) = result.as_array_mut() {
            sessions.retain(|session| {
                session["id"]
                    .as_str()
                    .is_some_and(|id| scope.session_ids.iter().any(|allowed| allowed == id))
            });
        }
    }
    if method == "hosts.snapshot" {
        let sessions = context.app.state::<AppState>().ssh.list();
        if let Some(hosts) = result.get_mut("hosts").and_then(Value::as_array_mut) {
            hosts.retain(|host| {
                host["id"].as_str().is_some_and(|id| {
                    scope.host_ids.iter().any(|allowed| allowed == id)
                        || sessions.iter().any(|session| {
                            session.host_id == id && scope.session_ids.contains(&session.id)
                        })
                })
            });
        }
        if let Some(groups) = result.get_mut("groups").and_then(Value::as_array_mut) {
            groups.clear();
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cancelled_request_guard_cannot_remove_a_reused_request_id() {
        let plugin = uuid::Uuid::new_v4().to_string();
        let key = format!("{plugin}:1:request");
        let register = || {
            let registration = uuid::Uuid::new_v4();
            let (sender, receiver) = oneshot::channel();
            register_pending(
                &key,
                Pending {
                    registration,
                    plugin: plugin.clone(),
                    generation: 1,
                    client: "client".into(),
                    cancel: sender,
                },
            )
            .unwrap();
            (PendingGuard(key.clone(), registration), receiver)
        };
        let (old_guard, _old_receiver) = register();
        assert_eq!(cancel_pending(&plugin, 1, "request", "tools.cancel").0, 1);
        let (new_guard, _new_receiver) = register();
        drop(old_guard);
        assert!(pending().lock().unwrap().contains_key(&key));
        drop(new_guard);
        assert!(!pending().lock().unwrap().contains_key(&key));
    }
    #[test]
    fn concurrent_revoke_cannot_miss_a_registering_request() {
        let plugin = uuid::Uuid::new_v4().to_string();
        for index in 0..64 {
            let client = format!("client-{index}");
            let key = format!("{plugin}:1:{index}");
            let (sender, mut receiver) = oneshot::channel();
            let barrier = std::sync::Barrier::new(2);
            std::thread::scope(|threads| {
                let barrier = &barrier;
                let key = &key;
                let plugin = &plugin;
                let client = &client;
                let registered = threads.spawn(move || {
                    barrier.wait();
                    register_pending(
                        key,
                        Pending {
                            registration: uuid::Uuid::new_v4(),
                            plugin: plugin.clone(),
                            generation: 1,
                            client: client.clone(),
                            cancel: sender,
                        },
                    )
                });
                barrier.wait();
                cancel_pending(plugin, 1, client, "tools.revokeClient");
                let result = registered.join().unwrap();
                if result.is_ok() {
                    assert_eq!(receiver.try_recv(), Ok(()));
                }
            });
            assert!(client_revoked(&plugin, 1, &client));
            assert!(!pending().lock().unwrap().contains_key(&key));
        }
        resources()
            .lock()
            .unwrap()
            .retain(|item| item.plugin != plugin);
    }
    #[test]
    fn tool_scope_bounds_lists_and_values() {
        let mut scope = Scope::default();
        assert!(validate_scope(&scope).is_ok());
        scope.session_ids = vec!["session".into(); 65];
        assert!(validate_scope(&scope).is_err());
        scope.session_ids = vec!["s".repeat(129)];
        assert!(validate_scope(&scope).is_err());
        scope.session_ids.clear();
        scope.local_roots = vec!["x".repeat(32769)];
        assert!(validate_scope(&scope).is_err());
        scope.local_roots = vec!["/valid".into()];
        scope.remote_roots = vec![RemoteRoot {
            session_id: "s".into(),
            path: "/a\0b".into(),
        }];
        assert!(validate_scope(&scope).is_err());
    }
    #[test]
    fn readonly_has_no_shell_or_writes() {
        assert!(read_only("files.local.readText"));
        for method in [
            "sessions.exec",
            "tasks.start",
            "terminal.write",
            "files.local.delete",
            "files.upload",
        ] {
            assert!(!read_only(method));
        }
    }
    #[test]
    fn remote_scope_requires_component_boundary() {
        assert!(remote_within("/a/file", "/a"));
        assert!(!remote_within("/ab/file", "/a"));
        assert!(remote_within("/abc", "/"));
    }
    #[test]
    fn only_task_and_file_tools_are_exposed() {
        for method in [
            "tools.invoke",
            "secrets.get",
            "settings.update",
            "clipboard.readText",
            "terminal.write",
        ] {
            assert!(!allowed(method));
        }
    }
    #[test]
    fn local_scope_rejects_relative_and_escape() {
        let root = std::env::temp_dir().join(format!("tunnelde-scope-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let roots = vec![root.to_string_lossy().into_owned()];
        assert!(local_path("relative", &roots).is_err());
        assert!(local_path(&root.join("new.txt").to_string_lossy(), &roots).is_ok());
        assert!(local_path(&std::env::temp_dir().to_string_lossy(), &roots).is_err());
        std::fs::remove_dir(root).unwrap();
    }
}
