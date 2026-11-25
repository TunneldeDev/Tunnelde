//! Opt-in development capability. No arbitrary eval, invoke or SQL transport.
mod fixture;
use crate::{
    error::{AppError, AppResult},
    state::AppState,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{AppHandle, Manager};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::{TcpListener, TcpStream},
    sync::watch,
};

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Parameters {
    preset: String,
    theme: String,
    locale: String,
    width: u32,
    height: u32,
    count: u32,
    seed: u32,
}
impl Parameters {
    fn validate(&self) -> Result<(), String> {
        if ![
            "normal", "empty", "loading", "error", "boundary", "disabled",
        ]
        .contains(&self.preset.as_str())
            || !["dark", "light"].contains(&self.theme.as_str())
            || !["zh-CN", "en-US"].contains(&self.locale.as_str())
            || !(280..=3840).contains(&self.width)
            || !(200..=2160).contains(&self.height)
            || self.count > 10000
            || self.seed > 2147483647
        {
            return Err("invalid scenario parameters".into());
        }
        Ok(())
    }
}
const SURFACES: &[&str] = &[
    "workbench",
    "hosts",
    "host-details",
    "host-transfer",
    "connect",
    "connections",
    "known-hosts",
    "terminal",
    "files",
    "editor",
    "editor-conflict",
    "preview",
    "forwarding",
    "socks",
    "monitor",
    "processes",
    "tasks",
    "output",
    "history",
    "plugins",
    "plugin-details",
    "plugin-view",
    "welcome",
    "about",
    "dialogs",
    "menus",
    "notifications",
    "forms",
    "floating",
    "settings-general",
    "settings-network",
    "settings-appearance",
    "settings-workspace",
    "settings-terminal",
    "settings-shortcuts",
    "settings-files",
    "settings-editor",
    "settings-monitor",
    "settings-updates",
    "settings-plugins",
    "settings-advanced",
    "settings-about",
    "settings-habits",
];
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Apply {
    generation: u64,
    scenario_id: String,
    parameters: Parameters,
}
#[derive(Default)]
struct Inner {
    generation: u64,
    request: Option<Value>,
    ready: bool,
    preparing: bool,
    error: Option<String>,
    snapshot: Value,
    action: Option<Value>,
    result: Option<Value>,
}
struct Runtime {
    mode: String,
    run_id: String,
    data: PathBuf,
    inner: Mutex<Inner>,
    shutdown: watch::Sender<bool>,
}
impl Drop for Runtime {
    fn drop(&mut self) {
        let _ = self.shutdown.send(true);
        let _ = std::fs::remove_file(self.data.join("debugger.json"));
    }
}
type Shared = Arc<Runtime>;

pub(crate) fn start(app: &AppHandle) -> AppResult<()> {
    if std::env::var("TUNNELDE_DEBUGGER_ACTIVE").as_deref() != Ok("1") {
        return Ok(());
    }
    if app.config().identifier != "dev.tunnelde.debugtarget" {
        return Err(AppError::validation(
            "debugger requires isolated application identifier",
        ));
    }
    let run_id = std::env::var("TUNNELDE_DEBUGGER_RUN_ID")
        .map_err(|_| AppError::validation("missing debugger run ID"))?;
    uuid::Uuid::parse_str(&run_id).map_err(|_| AppError::validation("invalid debugger run ID"))?;
    let mode = std::env::var("TUNNELDE_DEBUGGER_MODE").unwrap_or_default();
    if !["native-mock", "native-service"].contains(&mode.as_str()) {
        return Err(AppError::validation("invalid debugger mode"));
    }
    let data = app
        .state::<AppState>()
        .data_dir
        .canonicalize()
        .map_err(|_| AppError::validation("invalid debugger profile"))?;
    let marker: Value = serde_json::from_slice(
        &std::fs::read(data.join(".debugger-profile"))
            .map_err(|_| AppError::validation("missing debugger profile marker"))?,
    )
    .map_err(|_| AppError::validation("invalid debugger marker"))?;
    if marker["runId"] != run_id || marker["version"] != 1 {
        return Err(AppError::validation("debugger profile mismatch"));
    }
    let (shutdown, stopped) = watch::channel(false);
    let runtime = Arc::new(Runtime {
        mode,
        run_id,
        data,
        inner: Mutex::new(Inner::default()),
        shutdown,
    });
    app.manage(runtime.clone());
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = serve(app, runtime, stopped).await {
            tracing::warn!(target: "debugger", kind = ?error.kind(), "Development debugger stopped");
        }
    });
    Ok(())
}
pub(crate) fn stop(app: &AppHandle) {
    if let Some(runtime) = app.try_state::<Shared>() {
        let _ = runtime.shutdown.send(true);
        let _ = std::fs::remove_file(runtime.data.join("debugger.json"));
    }
}
async fn serve(
    app: AppHandle,
    runtime: Shared,
    stopped: watch::Receiver<bool>,
) -> std::io::Result<()> {
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await?;
    let token = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let endpoint = json!({"version":1,"address":listener.local_addr()?.to_string(),"token":token,"runId":runtime.run_id});
    let path = runtime.data.join("debugger.json");
    {
        use std::io::Write;
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&path)?;
        file.write_all(&serde_json::to_vec(&endpoint)?)?;
    }
    let result = crate::automation::transport::listener::serve(listener, stopped, move |stream| {
        let app = app.clone();
        let runtime = runtime.clone();
        let token = token.clone();
        async move { connection(stream, app, runtime, &token).await }
    })
    .await;
    let _ = std::fs::remove_file(path);
    result
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    version: u8,
    id: String,
    token: String,
    run_id: String,
    method: String,
    params: Value,
}
fn authenticate(request: &Request, token: &str, run_id: &str) -> Result<(), String> {
    if request.token.len() != 64
        || !crate::automation::transport::equal(&request.token, token)
        || request.run_id != run_id
    {
        return Err("unauthorized".into());
    }
    if request.version != 1
        || request.id.is_empty()
        || request.id.len() > 128
        || request.id.chars().any(char::is_control)
        || !request.params.is_object()
    {
        return Err("invalid_request".into());
    }
    Ok(())
}
async fn connection(
    stream: TcpStream,
    app: AppHandle,
    runtime: Shared,
    token: &str,
) -> std::io::Result<()> {
    tokio::time::timeout(Duration::from_secs(12), async {
        let mut reader = BufReader::new(stream);
        let mut bytes = Vec::new();
        (&mut reader)
            .take(1024 * 1024 + 1)
            .read_until(b'\n', &mut bytes)
            .await?;
        let mut id = String::new();
        let result = if bytes.len() > 1024 * 1024 || bytes.last() != Some(&b'\n') {
            Err("invalid_request".into())
        } else {
            match serde_json::from_slice::<Request>(&bytes) {
                Err(_) => Err("invalid_request".into()),
                Ok(request) => {
                    id.clone_from(&request.id);
                    match authenticate(&request, token, &runtime.run_id) {
                        Err(error) => Err(error),
                        Ok(()) => call(&app, &runtime, &request.method, request.params).await,
                    }
                }
            }
        };
        let response = match result {
            Ok(value) => json!({"version":1,"id":id,"result":value}),
            Err(error) => {
                json!({"version":1,"id":id,"error":{"code":"debugger_rejected","message":error}})
            }
        };
        let mut output = serde_json::to_vec(&response)?;
        if output.len() > 4 * 1024 * 1024 {
            return Err(std::io::ErrorKind::InvalidData.into());
        }
        output.push(b'\n');
        reader.get_mut().write_all(&output).await?;
        reader.get_mut().shutdown().await
    })
    .await
    .map_err(|_| std::io::ErrorKind::TimedOut)?
}
async fn call(
    app: &AppHandle,
    runtime: &Shared,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    match method {
        "debug.describe" => Ok(
            json!({"protocol":1,"runId":runtime.run_id,"mode":runtime.mode,"surfaces":SURFACES,"methods":["debug.describe","debug.apply","debug.snapshot","debug.windows","debug.present","debug.check","debug.events"],"realServiceMaxCount":1000}),
        ),
        "debug.snapshot" | "debug.events" => {
            let inner = runtime
                .inner
                .lock()
                .map_err(|_| "debugger state poisoned")?;
            Ok(
                json!({"generation":inner.generation,"ready":inner.ready,"error":inner.error,"snapshot":inner.snapshot,"result":inner.result}),
            )
        }
        "debug.apply" => {
            let input: Apply =
                serde_json::from_value(params).map_err(|_| "invalid scene request")?;
            input.parameters.validate()?;
            if !SURFACES.contains(&input.scenario_id.as_str()) {
                return Err("unregistered scene".into());
            }
            {
                let mut inner = runtime
                    .inner
                    .lock()
                    .map_err(|_| "debugger state poisoned")?;
                if input.generation <= inner.generation || inner.preparing {
                    return Err("stale generation or preparation pending".into());
                }
                if runtime.mode == "native-service" && inner.generation > 0 {
                    return Err("real-service reset requires a fresh profile".into());
                }
                inner.generation = input.generation;
                inner.ready = false;
                inner.error = None;
                inner.preparing = true;
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_min_size(Some(tauri::LogicalSize::new(280.0, 200.0)));
                let _ = window.set_size(tauri::LogicalSize::new(
                    input.parameters.width as f64,
                    input.parameters.height as f64,
                ));
            }
            let prepared = if runtime.mode == "native-service" {
                prepare_real(app, runtime, &input).await
            } else {
                Ok(json!({}))
            };
            let mut inner = runtime
                .inner
                .lock()
                .map_err(|_| "debugger state poisoned")?;
            inner.preparing = false;
            match prepared {
                Ok(prepared) => {
                    inner.request = Some(
                        json!({"generation":input.generation,"scenarioId":input.scenario_id,"parameters":input.parameters,"mode":runtime.mode,"prepared":prepared}),
                    );
                    Ok(json!({"accepted":true,"generation":input.generation}))
                }
                Err(error) => {
                    inner.error = Some(error.clone());
                    Err(error)
                }
            }
        }
        "debug.present" | "debug.check" => {
            let generation = params["generation"].as_u64().ok_or("generation required")?;
            let placement = if method == "debug.check" {
                "verify"
            } else {
                params["placement"].as_str().ok_or("placement required")?
            };
            if !["native", "main", "floating", "verify"].contains(&placement) {
                return Err("unregistered placement".into());
            }
            let mut inner = runtime
                .inner
                .lock()
                .map_err(|_| "debugger state poisoned")?;
            if generation != inner.generation || !inner.ready || inner.action.is_some() {
                return Err("stale or unavailable scene".into());
            }
            if runtime.mode != "native-service" && placement != "verify" {
                return Err("window ownership acceptance requires real-service mode".into());
            }
            let id = uuid::Uuid::new_v4().to_string();
            inner.result = None;
            inner.action = Some(json!({"id":id,"generation":generation,"placement":placement}));
            Ok(json!({"accepted":true,"id":id}))
        }
        "debug.focus" => {
            let label = params["label"].as_str().unwrap_or("main");
            let window = app
                .get_webview_window(label)
                .ok_or("unknown target window")?;
            window.show().map_err(|error| error.to_string())?;
            window.unminimize().map_err(|error| error.to_string())?;
            window.set_focus().map_err(|error| error.to_string())?;
            Ok(json!({"focused":label}))
        }
        "debug.windows" => windows(app).await,
        _ => Err("unknown debugger method".into()),
    }
}
async fn prepare_real(app: &AppHandle, runtime: &Shared, input: &Apply) -> Result<Value, String> {
    if !input.scenario_id.starts_with("settings-")
        && ![
            "workbench",
            "hosts",
            "host-details",
            "terminal",
            "files",
            "editor",
            "floating",
        ]
        .contains(&input.scenario_id.as_str())
    {
        return Err("scene has no real-service adapter".into());
    }
    crate::services::settings::update(app, json!({"theme":input.parameters.theme,"language":input.parameters.locale,"autoCheckUpdates":false,"restoreWorkspace":false,"disconnectOnPanelClose":false,"closeToTray":false})).await.map_err(|error| error.to_string())?;
    let fixture = if ["terminal", "files"].contains(&input.scenario_id.as_str()) {
        Some(fixture::start(runtime.data.join("files")).await?)
    } else {
        None
    };
    let count = if input.parameters.preset == "empty" {
        0
    } else {
        input.parameters.count.clamp(1, 1000)
    };
    let app = app.clone();
    let scenario_id = input.scenario_id.clone();
    let hosts = tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>(); let service = crate::services::hosts::service(&app, &state); let mut hosts = Vec::new();
        for i in 0..count { let host: crate::models::HostInput = serde_json::from_value(json!({"name":format!("Debugger host {:04}", i + 1),"host":if fixture.is_some() { "127.0.0.1" } else { "example.test" },"port":fixture.as_ref().map(|f| f.port).unwrap_or(22),"username":"debugger","authMethod":"password","tags":["synthetic",scenario_id]})).map_err(|error| error.to_string())?; hosts.push(service.create(host).map_err(|error| error.to_string())?); }
        Ok::<_, String>((hosts, fixture))
    }).await.map_err(|error| error.to_string())??;
    Ok(json!({"hosts":hosts.0,"fileRoot":runtime.data.join("files"),"fixture":hosts.1}))
}
async fn windows(app: &AppHandle) -> Result<Value, String> {
    let (send, receive) = tokio::sync::oneshot::channel();
    let cloned = app.clone();
    app.run_on_main_thread(move || {
        let windows: Vec<Value> = cloned.webview_windows().into_iter().map(|(label, window)| {
            #[cfg(target_os = "macos")]
            let number = window.ns_window().ok().map(|pointer| unsafe { (&*(pointer as *const objc2_app_kit::NSWindow)).windowNumber() });
            #[cfg(not(target_os = "macos"))]
            let number: Option<i64> = None;
            json!({"label":label,"number":number,"visible":window.is_visible().unwrap_or(false)})
        }).collect(); let _ = send.send(json!({"windows":windows}));
    }).map_err(|error| error.to_string())?;
    receive.await.map_err(|error| error.to_string())
}
#[tauri::command]
pub(crate) fn debugger_context(app: AppHandle) -> AppResult<Value> {
    let runtime = app
        .try_state::<Shared>()
        .ok_or_else(|| AppError::validation("debugger inactive"))?;
    Ok(json!({"version":1,"mode":runtime.mode,"runId":runtime.run_id}))
}
#[tauri::command]
pub(crate) fn debugger_poll(app: AppHandle, generation: u64) -> AppResult<Value> {
    let runtime = app
        .try_state::<Shared>()
        .ok_or_else(|| AppError::validation("debugger inactive"))?;
    let inner = runtime
        .inner
        .lock()
        .map_err(|_| AppError::internal("debugger state poisoned"))?;
    Ok(
        json!({"request":if inner.generation > generation { inner.request.clone() } else { None },"action":inner.action}),
    )
}
#[tauri::command]
pub(crate) fn debugger_ack(
    app: AppHandle,
    generation: u64,
    snapshot: Value,
    error: Option<String>,
) -> AppResult<()> {
    if snapshot.to_string().len() > 128 * 1024 || error.as_ref().is_some_and(|e| e.len() > 4096) {
        return Err(AppError::validation("debugger snapshot exceeds budget"));
    }
    let runtime = app
        .try_state::<Shared>()
        .ok_or_else(|| AppError::validation("debugger inactive"))?;
    let mut inner = runtime
        .inner
        .lock()
        .map_err(|_| AppError::internal("debugger state poisoned"))?;
    if generation != inner.generation || inner.ready || inner.preparing || inner.request.is_none() {
        return Err(AppError::validation("stale debugger generation"));
    }
    inner.ready = error.is_none();
    inner.error = error;
    inner.snapshot = snapshot;
    Ok(())
}
#[tauri::command]
pub(crate) fn debugger_result(
    app: AppHandle,
    generation: u64,
    id: String,
    result: Value,
) -> AppResult<()> {
    let runtime = app
        .try_state::<Shared>()
        .ok_or_else(|| AppError::validation("debugger inactive"))?;
    let mut inner = runtime
        .inner
        .lock()
        .map_err(|_| AppError::internal("debugger state poisoned"))?;
    if generation != inner.generation
        || inner.action.as_ref().and_then(|a| a["id"].as_str()) != Some(&id)
        || result.to_string().len() > 128 * 1024
    {
        return Err(AppError::validation("stale debugger action"));
    }
    inner.action = None;
    inner.result = Some(result);
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_authentication_and_old_protocol() {
        let token = "a".repeat(64);
        let mut request = Request {
            version: 1,
            id: "test".into(),
            token: token.clone(),
            run_id: "run".into(),
            method: "debug.describe".into(),
            params: json!({}),
        };
        assert!(authenticate(&request, &token, "run").is_ok());
        request.token = "b".repeat(64);
        assert!(authenticate(&request, &token, "run").is_err());
        request.token = token.clone();
        request.version = 2;
        assert!(authenticate(&request, &token, "run").is_err());
    }
    #[test]
    fn rejects_invalid_scene_parameters() {
        let mut p = Parameters {
            preset: "normal".into(),
            theme: "dark".into(),
            locale: "zh-CN".into(),
            width: 1280,
            height: 800,
            count: 24,
            seed: 42,
        };
        assert!(p.validate().is_ok());
        p.count = 10001;
        assert!(p.validate().is_err());
    }
}
