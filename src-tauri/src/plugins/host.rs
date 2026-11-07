use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::Manager;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command};
use tokio::sync::{oneshot, Mutex};
use tokio::task::JoinSet;

use super::api::{self, HostContext};
use super::security::Lease;
use crate::error::{AppError, AppResult};

type Pending = Arc<StdMutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>;

struct PendingRequest {
    pending: Pending,
    id: u64,
}

impl Drop for PendingRequest {
    fn drop(&mut self) {
        self.pending
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(&self.id);
    }
}

pub struct PluginHost {
    child: Child,
    stdin: Arc<Mutex<ChildStdin>>,
    pending: Pending,
    next_id: AtomicU64,
}

impl PluginHost {
    pub async fn spawn(
        node: &str,
        entry: &Path,
        working_dir: &Path,
        context: Option<HostContext>,
    ) -> AppResult<Self> {
        let mut command = Command::new(node);
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        if let Some(context) = &context {
            crate::network::process_environment(&context.app, &context.id, &mut command)?;
        }
        let mut child = command
            .arg(node_path(entry))
            .current_dir(node_path(working_dir))
            .env_remove("NODE_OPTIONS")
            .env_remove("NODE_REPL_EXTERNAL_MODULE")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|error| AppError::Validation(format!("plugin.spawn: {error}")))?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| AppError::internal("plugin.stdin"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| AppError::internal("plugin.stdout"))?;
        let stderr = child.stderr.take();
        let stdin = Arc::new(Mutex::new(stdin));
        let pending: Pending = Arc::new(StdMutex::new(HashMap::new()));

        let plugin_id = context.as_ref().map(|context| context.id.clone());
        tokio::spawn(read_loop(stdout, stdin.clone(), pending.clone(), context));
        if let Some(stderr) = stderr {
            tokio::spawn(stderr_loop(stderr, plugin_id));
        }

        Ok(Self {
            child,
            stdin,
            pending,
            next_id: AtomicU64::new(1),
        })
    }

    pub async fn request(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> AppResult<Value> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (sender, receiver) = oneshot::channel();
        self.pending
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(id, sender);
        let _request = PendingRequest {
            pending: self.pending.clone(),
            id,
        };

        let payload = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        let exchange = async {
            self.write(&payload).await?;
            match receiver.await {
                Err(_) => Err(AppError::validation("plugin.exited")),
                Ok(Ok(value)) => Ok(value),
                Ok(Err(message)) => Err(AppError::validation(format!("plugin.error: {message}"))),
            }
        };
        tokio::time::timeout(timeout, exchange)
            .await
            .unwrap_or_else(|_| Err(AppError::validation("plugin.timeout")))
    }

    async fn write(&self, payload: &Value) -> AppResult<()> {
        let mut line = serde_json::to_string(payload)?;
        if !line.ends_with('\n') {
            line.push('\n');
        }
        let mut stdin = self.stdin.lock().await;
        stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|error| AppError::Validation(format!("plugin.write: {error}")))?;
        stdin
            .flush()
            .await
            .map_err(|error| AppError::Validation(format!("plugin.write: {error}")))
    }

    pub fn kill(&mut self) {
        let _ = self.child.start_kill();
    }
}

// Node's JS module resolver treats Windows verbatim paths as URL-like input in
// several loaders. Keep canonical validation, then pass an ordinary drive/UNC
// path to Node, preserving the underlying OsString (including non-Unicode names).
fn node_path(path: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        use std::path::{Component, Prefix};
        let mut parts = path.components();
        if let Some(Component::Prefix(prefix)) = parts.next() {
            let mut converted = match prefix.kind() {
                Prefix::VerbatimDisk(drive) => PathBuf::from(format!("{}:\\", drive as char)),
                Prefix::VerbatimUNC(server, share) => {
                    let mut value = std::ffi::OsString::from("\\\\");
                    value.push(server);
                    value.push("\\");
                    value.push(share);
                    PathBuf::from(value)
                }
                _ => return path.to_owned(),
            };
            for part in parts {
                if !matches!(part, Component::RootDir) {
                    converted.push(part.as_os_str());
                }
            }
            return converted;
        }
    }
    path.to_owned()
}

#[cfg(all(test, windows))]
mod path_tests {
    use super::*;
    #[test]
    fn converts_verbatim_drive_and_unc_paths_for_node() {
        assert_eq!(
            node_path(Path::new(r"\\?\C:\插件\index.js")),
            PathBuf::from(r"C:\插件\index.js")
        );
        assert_eq!(
            node_path(Path::new(r"\\?\UNC\server\share\plugin.js")),
            PathBuf::from(r"\\server\share\plugin.js")
        );
        assert_eq!(
            node_path(Path::new(r"C:\normal\index.js")),
            PathBuf::from(r"C:\normal\index.js")
        );
    }
}

async fn read_loop(
    stdout: ChildStdout,
    stdin: Arc<Mutex<ChildStdin>>,
    pending: Pending,
    context: Option<HostContext>,
) {
    let mut reader = BufReader::new(stdout);
    let mut requests = JoinSet::new();

    loop {
        let line = match bounded_line(&mut reader, 1024 * 1024 + 4096).await {
            Ok(Some(line)) => line,
            Ok(None) => break,
            Err(error) => {
                tracing::warn!(%error, "plugin stdout closed with an error");
                break;
            }
        };
        if line.trim().is_empty() {
            continue;
        }

        let value: Value = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(error) => {
                tracing::warn!(%error, line = %line.chars().take(200).collect::<String>(), "plugin sent invalid json");
                continue;
            }
        };

        while requests.try_join_next().is_some() {}
        let request_id = value
            .get("id")
            .filter(|id| id.is_string() || id.is_number());
        if value.get("method").is_some() {
            let log_notification = value.get("id").is_none()
                && value.get("method").and_then(Value::as_str) == Some("log");
            if request_id.is_some() || log_notification {
                if requests.len() >= 32 {
                    if let Some(id) = request_id {
                        if write_reply(
                            &stdin,
                            json!({"jsonrpc":"2.0","id":id,
                            "error":{"code":-32002,"message":"plugin.api.busy"}}),
                        )
                        .await
                        .is_err()
                        {
                            break;
                        }
                    }
                    continue;
                }
                let stdin = stdin.clone();
                let context = context.clone();
                requests.spawn(async move {
                    handle_plugin_request(value, &stdin, context).await;
                });
            }
            continue;
        }
        let id = value.get("id").and_then(Value::as_u64);

        match id {
            Some(id) => {
                if let Some(sender) = pending
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .remove(&id)
                {
                    let result = if let Some(error) = value.get("error") {
                        Err(error
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or("plugin error")
                            .to_string())
                    } else {
                        Ok(value.get("result").cloned().unwrap_or(Value::Null))
                    };
                    let _ = sender.send(result);
                }
            }
            None => {
                if let Some(method) = value.get("method").and_then(Value::as_str) {
                    tracing::debug!(method, "plugin notification");
                }
            }
        }
    }

    requests.abort_all();
    if let Some(context) = &context {
        super::tasks::cancel_plugin(&context.id, Some(context.generation));
        context
            .app
            .state::<crate::state::AppState>()
            .forwards
            .stop_generation(&context.id, context.generation);
        context
            .app
            .state::<crate::state::AppState>()
            .mounts
            .stop_generation(&context.id, context.generation)
            .await;
        context
            .app
            .state::<crate::state::AppState>()
            .transfers
            .cancel_plugin(&context.id, context.generation);
    }

    let mut pending = pending.lock().unwrap_or_else(|error| error.into_inner());
    for (_, sender) in pending.drain() {
        let _ = sender.send(Err("plugin exited".into()));
    }
}

async fn handle_plugin_request(
    value: Value,
    stdin: &Arc<Mutex<ChildStdin>>,
    context: Option<HostContext>,
) {
    let id = value.get("id").cloned();
    let method = value
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let params = value.get("params").cloned().unwrap_or_else(|| json!({}));
    let result = if value.get("jsonrpc").and_then(Value::as_str) != Some("2.0") || method.is_empty()
    {
        Err(AppError::validation("plugin.api.invalidRequest"))
    } else if let Err(error) = api::validate_params(&params) {
        Err(error)
    } else if let Some(context) = context {
        let security = context
            .app
            .state::<crate::state::AppState>()
            .plugins
            .security
            .clone();
        let lease = Lease {
            id: context.id.clone(),
            fingerprint: context.fingerprint.clone(),
            permissions: context.permissions.clone(),
            generation: context.generation,
        };
        tokio::time::timeout(
            Duration::from_secs(120),
            security.guard(&lease, api::dispatch(&context, method, params)),
        )
        .await
        .unwrap_or_else(|_| Err(AppError::validation("plugin.timeout")))
    } else {
        Err(AppError::validation("pluginSecurity.unavailable"))
    };
    let Some(id) = id else {
        return;
    };
    let reply = match result {
        Ok(result) if result.to_string().len() <= 1024 * 1024 => {
            json!({"jsonrpc":"2.0","id":id,"result":result})
        }
        Ok(_) => {
            json!({"jsonrpc":"2.0","id":id,"error":{"code":-32002,"message":"plugin.api.responseTooLarge"}})
        }
        Err(error) => json!({"jsonrpc":"2.0","id":id,"error":error_payload(&error)}),
    };
    let _ = write_reply(stdin, reply).await;
}

pub(super) fn error_payload(error: &AppError) -> Value {
    let message = error.to_string();
    let code = match message.as_str() {
        "plugin.api.unknownMethod" => -32601,
        "plugin.api.invalidRequest" => -32600,
        "plugin.api.invalidParams" => -32602,
        _ if message.starts_with("pluginSecurity.") => -32001,
        _ => -32000,
    };
    json!({"code":code,"message":message,"data":{"code":error.code()}})
}

async fn write_reply(stdin: &Arc<Mutex<ChildStdin>>, reply: Value) -> AppResult<()> {
    let mut line = reply.to_string();
    line.push('\n');
    tokio::time::timeout(Duration::from_secs(2), async {
        let mut writer = stdin.lock().await;
        writer.write_all(line.as_bytes()).await?;
        writer.flush().await
    })
    .await
    .map_err(|_| AppError::validation("plugin.timeout"))??;
    Ok(())
}

async fn stderr_loop(stderr: ChildStderr, plugin_id: Option<String>) {
    let mut reader = BufReader::new(stderr);
    while let Ok(Some(line)) = read_limited_line(&mut reader, 16 * 1024, true).await {
        if !line.trim().is_empty() {
            tracing::warn!(target: "plugin", plugin_id = plugin_id.as_deref().unwrap_or("unknown"), message = %line, "plugin stderr");
        }
    }
}

async fn bounded_line(
    reader: &mut (impl AsyncBufRead + Unpin),
    max: usize,
) -> std::io::Result<Option<String>> {
    read_limited_line(reader, max, false).await
}

async fn read_limited_line(
    reader: &mut (impl AsyncBufRead + Unpin),
    max: usize,
    truncate: bool,
) -> std::io::Result<Option<String>> {
    let mut bytes = Vec::new();
    let mut truncated = false;
    loop {
        let chunk = reader.fill_buf().await?;
        if chunk.is_empty() {
            if bytes.is_empty() {
                return Ok(None);
            }
            break;
        }
        let end = chunk.iter().position(|byte| *byte == b'\n');
        let count = end.map_or(chunk.len(), |index| index + 1);
        if bytes.len().saturating_add(count) > max && !truncate {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "plugin response exceeds limit",
            ));
        }
        let kept = count.min(max.saturating_sub(bytes.len()));
        bytes.extend_from_slice(&chunk[..kept]);
        truncated |= kept < count;
        reader.consume(count);
        if end.is_some() {
            break;
        }
    }
    if truncate {
        let mut text = String::from_utf8_lossy(&bytes).into_owned();
        if truncated {
            text.push_str(" [truncated]");
        }
        return Ok(Some(text));
    }
    String::from_utf8(bytes)
        .map(Some)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use sha2::{Digest, Sha256};
    use std::path::PathBuf;

    fn legacy_plugin_dir() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../tests/fixtures/plugin-compat/v0.28.0/hello")
    }

    #[test]
    fn historical_plugin_fixture_is_unchanged_and_its_manifest_loads() {
        let dir = legacy_plugin_dir();
        for (file, expected) in [
            (
                "index.js",
                "37d1f7bea3c914b1201634ba1984cd63889cf729c920a51cc8e5c51807881a71",
            ),
            (
                "tunnelde-plugin.json",
                "8c6ed23bce2313cbf7888a9245902c875c21254cde8600e28abbfa9943f0a646",
            ),
        ] {
            let data = std::fs::read(dir.join(file)).expect("historical fixture must exist");
            assert_eq!(format!("{:x}", Sha256::digest(data)), expected, "{file}");
        }
        let manifest = super::super::manifest::load(&dir).expect("load historical manifest");
        assert_eq!(manifest.api_version, 1);
        assert_eq!(manifest.id, "hello");
        assert_eq!(manifest.main, "index.js");
    }

    #[test]
    fn frozen_core_sdk_is_unchanged_and_probe_manifest_loads() {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../tests/fixtures/plugin-compat/core-sdk-v1");
        let bytes = std::fs::read(dir.join("sdk.mjs")).unwrap();
        assert_eq!(
            format!("{:x}", Sha256::digest(bytes)),
            "c8f22cd663e1978e5ad751e24f27ade321b74746896e915c66a1a1f478f9aaf9"
        );
        let manifest = super::super::manifest::load(&dir).unwrap();
        assert_eq!(manifest.id, "qa-core-sdk");
        assert_eq!(manifest.permissions, ["sessions.read"]);
    }

    #[tokio::test]
    async fn bounded_lines_handle_split_utf8_and_reject_excess_without_a_newline() {
        let mut reader = BufReader::with_capacity(2, "中文\nsecond".as_bytes());
        assert_eq!(
            bounded_line(&mut reader, 16).await.unwrap().as_deref(),
            Some("中文\n")
        );
        assert_eq!(
            bounded_line(&mut reader, 16).await.unwrap().as_deref(),
            Some("second")
        );
        assert!(bounded_line(&mut reader, 16).await.unwrap().is_none());
        let large = vec![b'x'; 1024 * 1024 + 4097];
        let mut reader = BufReader::new(large.as_slice());
        assert!(bounded_line(&mut reader, 1024 * 1024 + 4096).await.is_err());
    }

    #[tokio::test]
    async fn stderr_truncates_one_oversized_line_and_preserves_following_lines() {
        let input = format!("{}\nnext\n", "x".repeat(100_000));
        let mut reader = BufReader::with_capacity(128, input.as_bytes());
        let line = read_limited_line(&mut reader, 1024, true)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(line.len(), 1024 + " [truncated]".len());
        assert_eq!(
            read_limited_line(&mut reader, 1024, true)
                .await
                .unwrap()
                .as_deref(),
            Some("next\n")
        );
    }

    #[tokio::test]
    async fn request_timeout_includes_writing_to_a_non_reading_process() {
        #[cfg(windows)]
        let mut cmd = {
            let root = std::env::var_os("SystemRoot").unwrap();
            let mut cmd = Command::new(PathBuf::from(root).join("System32/PING.EXE"));
            cmd.args(["-n", "5", "127.0.0.1"])
                .creation_flags(0x08000000);
            cmd
        };
        #[cfg(not(windows))]
        let mut cmd = {
            let mut cmd = Command::new("/bin/sleep");
            cmd.arg("5");
            cmd
        };
        let mut child = cmd
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let stdin = child.stdin.take().unwrap();
        let mut host = PluginHost {
            child,
            stdin: Arc::new(Mutex::new(stdin)),
            pending: Arc::new(StdMutex::new(HashMap::new())),
            next_id: AtomicU64::new(1),
        };
        let result = host
            .request(
                "blocked",
                json!({"body":"x".repeat(256 * 1024)}),
                Duration::from_millis(100),
            )
            .await;
        assert!(result.unwrap_err().to_string().contains("plugin.timeout"));
        assert!(host.pending.lock().unwrap().is_empty());
        host.kill();
        let _ = host.child.wait().await;
    }

    #[tokio::test]
    async fn cancelled_request_removes_its_pending_response() {
        #[cfg(windows)]
        let mut command = {
            let root = std::env::var_os("SystemRoot").unwrap();
            let mut command = Command::new(PathBuf::from(root).join("System32/PING.EXE"));
            command
                .args(["-n", "5", "127.0.0.1"])
                .creation_flags(0x08000000);
            command
        };
        #[cfg(not(windows))]
        let mut command = {
            let mut command = Command::new("/bin/sleep");
            command.arg("5");
            command
        };
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let stdin = child.stdin.take().unwrap();
        let mut host = PluginHost {
            child,
            stdin: Arc::new(Mutex::new(stdin)),
            pending: Arc::new(StdMutex::new(HashMap::new())),
            next_id: AtomicU64::new(1),
        };
        let (other_sender, mut other_receiver) = oneshot::channel();
        host.pending.lock().unwrap().insert(99, other_sender);
        let result = tokio::time::timeout(
            Duration::from_millis(100),
            host.request("unanswered", json!({}), Duration::from_secs(5)),
        )
        .await;
        assert!(result.is_err());
        let other = host
            .pending
            .lock()
            .unwrap()
            .remove(&99)
            .expect("another request stays registered");
        assert!(host.pending.lock().unwrap().is_empty());
        other.send(Ok(json!("answer"))).unwrap();
        assert_eq!(other_receiver.try_recv().unwrap().unwrap(), json!("answer"));
        host.kill();
        let _ = host.child.wait().await;
    }

    #[tokio::test]
    #[ignore = "requires explicit TUNNELDE_TEST_NODE executable"]
    async fn talks_json_rpc_with_the_example_plugin() {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../examples/plugins/hello");
        let entry = dir.join("index.js");
        assert!(entry.is_file(), "example plugin entry must exist");

        // Integration runs must explicitly opt into using a system executable.
        let node = std::env::var("TUNNELDE_TEST_NODE").expect("explicit test Node executable");

        let host = PluginHost::spawn(&node, &entry, &dir, None)
            .await
            .expect("spawn plugin");
        let initialized = host
            .request(
                "initialize",
                json!({ "apiVersion": 1 }),
                Duration::from_secs(10),
            )
            .await
            .expect("initialize");
        assert_eq!(initialized.get("ok").and_then(Value::as_bool), Some(true));

        let result = host
            .request(
                "command.run",
                json!({ "command": "greet" }),
                Duration::from_secs(10),
            )
            .await
            .expect("run command");
        let message = result
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        assert!(message.contains("Hello"));

        let view = host
            .request(
                "view.render",
                json!({ "view": "hello" }),
                Duration::from_secs(10),
            )
            .await
            .expect("render view");
        let blocks = view
            .get("blocks")
            .and_then(Value::as_array)
            .expect("blocks array");
        assert!(!blocks.is_empty());
        let _ = host
            .request("shutdown", json!({}), Duration::from_secs(2))
            .await;
    }

    #[tokio::test]
    #[ignore = "requires explicit TUNNELDE_TEST_NODE executable"]
    async fn talks_json_rpc_with_the_historical_v028_plugin() {
        let dir = legacy_plugin_dir();
        let manifest = super::super::manifest::load(&dir).expect("load historical plugin");
        let entry = super::super::manifest::entry_path(&dir, &manifest.main)
            .expect("validate historical entry");
        let node = std::env::var("TUNNELDE_TEST_NODE").expect("explicit test Node executable");
        let host = PluginHost::spawn(&node, &entry, &dir, None)
            .await
            .expect("spawn historical plugin");
        let timeout = Duration::from_secs(10);
        assert_eq!(
            host.request(
                "initialize",
                json!({"apiVersion":1,"pluginId":"hello"}),
                timeout
            )
            .await
            .unwrap(),
            json!({"ok":true})
        );
        assert_eq!(
            host.request(
                "command.run",
                json!({"command":"greet","input":{}}),
                timeout
            )
            .await
            .unwrap(),
            json!({"message":"Hello from the example plugin"})
        );
        let view = host
            .request(
                "view.render",
                json!({"view":"hello","locale":"en-US"}),
                timeout,
            )
            .await
            .unwrap();
        assert_eq!(view["title"], "Hello plugin");
        assert_eq!(view["blocks"].as_array().unwrap().len(), 4);
        let error = host
            .request("unknown.method", json!({}), timeout)
            .await
            .unwrap_err();
        assert!(error.to_string().contains("unknown method: unknown.method"));
        assert_eq!(
            host.request("shutdown", json!({}), timeout).await.unwrap(),
            Value::Null
        );
    }

    #[tokio::test]
    #[ignore = "requires explicit TUNNELDE_TEST_NODE executable"]
    async fn talks_json_rpc_with_the_frozen_core_sdk() {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../tests/fixtures/plugin-compat/core-sdk-v1");
        let manifest = super::super::manifest::load(&dir).unwrap();
        let entry = super::super::manifest::entry_path(&dir, &manifest.main).unwrap();
        let node = std::env::var("TUNNELDE_TEST_NODE").expect("explicit test Node executable");
        let host = PluginHost::spawn(&node, &entry, &dir, None).await.unwrap();
        let timeout = Duration::from_secs(10);
        assert_eq!(
            host.request(
                "initialize",
                json!({"apiVersion":1,"pluginId":"qa-core-sdk"}),
                timeout
            )
            .await
            .unwrap(),
            json!({"ok":true})
        );
        let error = host
            .request(
                "command.run",
                json!({"command":"call","input":{"method":"api.describe","captureError":true}}),
                timeout,
            )
            .await
            .unwrap();
        assert_eq!(
            error,
            json!({"code":-32001,"message":"pluginSecurity.unavailable","data":{"code":"validation"}})
        );
        assert_eq!(
            host.request("shutdown", json!({}), timeout).await.unwrap(),
            Value::Null
        );
    }
}
