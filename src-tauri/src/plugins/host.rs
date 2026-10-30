// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

use std::collections::HashMap;
use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command};
use tokio::sync::{oneshot, Mutex};

use crate::error::{AppError, AppResult};

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>;

pub struct PluginHost {
    child: Child,
    stdin: Arc<Mutex<ChildStdin>>,
    pending: Pending,
    next_id: AtomicU64,
}

impl PluginHost {
    pub async fn spawn(node: &str, entry: &Path, working_dir: &Path) -> AppResult<Self> {
        let mut child = Command::new(node)
            .arg(entry)
            .current_dir(working_dir)
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
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));

        tokio::spawn(read_loop(stdout, stdin.clone(), pending.clone()));
        if let Some(stderr) = stderr {
            tokio::spawn(stderr_loop(stderr));
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
        self.pending.lock().await.insert(id, sender);

        let payload = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        if let Err(error) = self.write(&payload).await {
            self.pending.lock().await.remove(&id);
            return Err(error);
        }

        match tokio::time::timeout(timeout, receiver).await {
            Err(_) => {
                self.pending.lock().await.remove(&id);
                Err(AppError::Validation("plugin.timeout".into()))
            }
            Ok(Err(_)) => Err(AppError::Validation("plugin.exited".into())),
            Ok(Ok(Ok(value))) => Ok(value),
            Ok(Ok(Err(message))) => Err(AppError::Validation(format!("plugin.error: {message}"))),
        }
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

async fn read_loop(stdout: ChildStdout, stdin: Arc<Mutex<ChildStdin>>, pending: Pending) {
    let mut reader = BufReader::new(stdout).lines();

    loop {
        let line = match reader.next_line().await {
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

        let id = value.get("id").and_then(Value::as_u64);

        match id {
            Some(id) if value.get("method").is_some() => {
                handle_plugin_request(&value, id, &stdin).await;
            }
            Some(id) => {
                if let Some(sender) = pending.lock().await.remove(&id) {
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

    let mut pending = pending.lock().await;
    for (_, sender) in pending.drain() {
        let _ = sender.send(Err("plugin exited".into()));
    }
}

async fn handle_plugin_request(value: &Value, id: u64, stdin: &Arc<Mutex<ChildStdin>>) {
    let method = value
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let reply = match method {
        "log" => {
            let level = value
                .pointer("/params/level")
                .and_then(Value::as_str)
                .unwrap_or("info");
            let message = value
                .pointer("/params/message")
                .and_then(Value::as_str)
                .unwrap_or_default();
            tracing::info!(level, message, "plugin log");
            json!({"jsonrpc": "2.0", "id": id, "result": null})
        }
        _ => json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": {"code": -32601, "message": format!("unknown method: {method}")},
        }),
    };

    let mut line = reply.to_string();
    line.push('\n');
    let mut writer = stdin.lock().await;
    let _ = writer.write_all(line.as_bytes()).await;
    let _ = writer.flush().await;
}

async fn stderr_loop(stderr: ChildStderr) {
    let mut reader = BufReader::new(stderr).lines();
    while let Ok(Some(line)) = reader.next_line().await {
        if !line.trim().is_empty() {
            tracing::warn!(target: "plugin", message = %line, "plugin stderr");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::path::PathBuf;

    #[tokio::test]
    async fn talks_json_rpc_with_the_example_plugin() {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../examples/plugins/hello");
        let entry = dir.join("index.js");
        if !entry.exists() {
            return;
        }

        let node = std::env::var("TUNNELDE_NODE").unwrap_or_else(|_| "node".to_string());
        if std::process::Command::new(&node)
            .arg("--version")
            .output()
            .is_err()
        {
            return;
        }

        let host = PluginHost::spawn(&node, &entry, &dir)
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

        let _ = host
            .request("shutdown", json!({}), Duration::from_secs(2))
            .await;
    }
}
