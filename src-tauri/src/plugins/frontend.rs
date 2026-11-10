//! Trusted, in-process frontend modules. Local transport and API leases are
//! bounded and revocable; already executing JavaScript is not sandboxed.
use std::collections::{BTreeMap, HashMap};
use std::path::{Component, Path};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{http, AppHandle, Manager, State};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

use super::api::HostContext;
use super::security::{FrontendSnapshot, Lease, PluginSecurity};
use crate::error::{AppError, AppResult};
use crate::state::AppState;

pub const UI_SDK_VERSION: &str = "0.1.0";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FrontendManifest {
    pub entry: String,
    pub sdk: String,
}

impl FrontendManifest {
    pub fn validate(&self, root: &Path) -> AppResult<()> {
        let mut parts = Path::new(&self.entry).components();
        if self.entry.contains('\\')
            || self.entry.split('/').any(|part| {
                part.is_empty()
                    || matches!(part, "." | "..")
                    || !part
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
            })
            || self.entry.len() > 240
            || parts.next() != Some(Component::Normal("ui".as_ref()))
            || parts.clone().next().is_none()
            || !parts.all(|part| matches!(part, Component::Normal(_)))
            || !self.entry.ends_with(".mjs")
        {
            return Err(AppError::validation("plugin.frontend.invalid"));
        }
        if self.sdk.len() > 160 || semver::VersionReq::parse(&self.sdk).is_err() {
            return Err(AppError::validation("plugin.frontend.invalidSdkRange"));
        }
        super::manifest::entry_path(root, &self.entry)?;
        Ok(())
    }

    pub fn require_sdk(&self) -> AppResult<()> {
        if !semver::VersionReq::parse(&self.sdk)
            .is_ok_and(|range| range.matches(&semver::Version::parse(UI_SDK_VERSION).unwrap()))
        {
            return Err(AppError::PluginUiSdkUnsupported {
                required: self.sdk.clone(),
                available: UI_SDK_VERSION.into(),
            });
        }
        Ok(())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrontendSession {
    pub token: String,
    pub plugin_id: String,
    pub generation: u64,
    pub entry: String,
    pub sdk_version: &'static str,
}

struct Module {
    lease: Lease,
    assets: BTreeMap<String, Arc<[u8]>>,
    bytes: usize,
}

pub struct Registry {
    modules: Mutex<HashMap<String, Module>>,
    requests: Arc<Semaphore>,
    snapshots: Arc<Semaphore>,
}

impl Default for Registry {
    fn default() -> Self {
        Self {
            modules: Mutex::new(HashMap::new()),
            requests: Arc::new(Semaphore::new(16)),
            snapshots: Arc::new(Semaphore::new(2)),
        }
    }
}

impl Registry {
    fn insert(
        &self,
        lease: Lease,
        snapshot: FrontendSnapshot,
        valid: impl Fn(&Lease) -> AppResult<()>,
    ) -> AppResult<(String, Vec<String>)> {
        let mut modules = self.modules.lock().unwrap_or_else(|e| e.into_inner());
        valid(&lease)?;
        let before: Vec<_> = modules.keys().cloned().collect();
        modules.retain(|_, item| valid(&item.lease).is_ok());
        // A recreated WebView may reopen the same runtime; retire its old URL.
        let bytes: usize = modules
            .values()
            .filter(|m| m.lease.id != lease.id)
            .map(|m| m.bytes)
            .sum();
        if modules.values().filter(|m| m.lease.id != lease.id).count() >= 16
            || bytes + snapshot.bytes > 32 * 1024 * 1024
        {
            return Err(AppError::validation("plugin.frontend.busy"));
        }
        modules.retain(|_, item| item.lease.id != lease.id);
        let token = uuid::Uuid::new_v4().to_string();
        modules.insert(
            token.clone(),
            Module {
                lease,
                assets: snapshot.assets,
                bytes: snapshot.bytes,
            },
        );
        let retired = before
            .into_iter()
            .filter(|token| !modules.contains_key(token))
            .collect();
        Ok((token, retired))
    }

    pub(super) fn lease(&self, token: &str) -> AppResult<Lease> {
        self.modules
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(token)
            .map(|m| m.lease.clone())
            .ok_or_else(|| AppError::validation("plugin.frontend.expired"))
    }

    /// Token replacement and final admission share the module lock. Callers must
    /// acquire policy only inside this callback, never in the opposite order.
    pub(super) fn with_lease<T>(
        &self,
        token: &str,
        operation: impl FnOnce(&Lease) -> AppResult<T>,
    ) -> AppResult<T> {
        let modules = self.modules.lock().unwrap_or_else(|e| e.into_inner());
        let module = modules
            .get(token)
            .ok_or_else(|| AppError::validation("plugin.frontend.expired"))?;
        operation(&module.lease)
    }

    pub(super) fn remove(&self, owner: &str, generation: impl Fn(u64) -> bool) {
        self.modules
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|_, item| item.lease.id != owner || !generation(item.lease.generation));
    }

    pub fn clear(&self) {
        self.modules
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
    }

    /// Reserve before spawning or allocating a response. The protocol callback
    /// retains this permit until it has handed the body to the WebView.
    pub fn request(&self) -> Option<OwnedSemaphorePermit> {
        self.requests.clone().try_acquire_owned().ok()
    }
}

fn authorized(security: &PluginSecurity, lease: &Lease) -> AppResult<()> {
    security
        .authorize(
            &lease.id,
            &lease.fingerprint,
            &lease.permissions,
            Some("ui.trusted"),
            Some(lease.generation),
        )
        .map(|_| ())
}

#[tauri::command]
pub async fn plugin_frontend_open(app: AppHandle, id: String) -> AppResult<FrontendSession> {
    let state = app.state::<AppState>();
    let handle = state.plugins.instance(&id).await?;
    let instance = handle.lock().await;
    if instance.retired {
        return Err(AppError::validation("plugin.notFound"));
    }
    instance.require_runtime()?;
    if instance.status != super::PluginStatus::Running {
        return Err(AppError::validation("plugin.notRunning"));
    }
    let frontend = instance
        .manifest
        .frontend
        .clone()
        .ok_or_else(|| AppError::validation("plugin.frontend.unavailable"))?;
    frontend.require_sdk()?;
    let lease = state.plugins.security.lease(
        &id,
        instance.fingerprint.clone(),
        instance.manifest.permissions.clone(),
    )?;
    authorized(&state.plugins.security, &lease)?;
    let capacity = app
        .state::<Registry>()
        .snapshots
        .clone()
        .try_acquire_owned()
        .map_err(|_| AppError::validation("plugin.frontend.busy"))?;
    let root = instance.dir.clone();
    let snapshot = tokio::task::spawn_blocking(move || {
        let _capacity = capacity;
        super::security::frontend_snapshot(&root, "ui/")
    });
    let snapshot = state
        .plugins
        .security
        .guard(&lease, async {
            snapshot
                .await
                .map_err(|_| AppError::internal("plugin.frontend.snapshot"))?
        })
        .await?;
    if snapshot.digest != lease.fingerprint {
        return Err(AppError::validation("pluginSecurity.approvalRequired"));
    }
    authorized(&state.plugins.security, &lease)?;
    if !snapshot
        .assets
        .contains_key(frontend.entry.trim_start_matches("ui/"))
    {
        return Err(AppError::validation("plugin.entry.missing"));
    }
    let generation = lease.generation;
    let (token, retired) = app.state::<Registry>().insert(lease, snapshot, |lease| {
        authorized(&state.plugins.security, lease)
    })?;
    for old_token in retired {
        super::forwarding::remove_token(&app, &old_token);
    }
    Ok(FrontendSession {
        token,
        plugin_id: id,
        generation,
        entry: frontend.entry.trim_start_matches("ui/").into(),
        sdk_version: UI_SDK_VERSION,
    })
}

#[tauri::command]
pub fn plugin_frontend_close(app: AppHandle, registry: State<'_, Registry>, token: String) {
    registry
        .modules
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&token);
    super::forwarding::remove_token(&app, &token);
}

#[tauri::command]
pub async fn plugin_frontend_failed(app: AppHandle, token: String) -> AppResult<super::PluginInfo> {
    let lease = app.state::<Registry>().lease(&token)?;
    let state = app.state::<AppState>();
    let handle = state.plugins.instance(&lease.id).await?;
    let mut instance = handle.lock().await;
    // Hold the owner lock while checking the generation and retiring resources.
    // A late activation failure must never stop a newly restarted instance.
    authorized(&state.plugins.security, &lease)?;
    if instance.retired || instance.status != super::PluginStatus::Running {
        return Err(AppError::validation("plugin.frontend.expired"));
    }
    state.plugins.revoke_background(&app, &lease.id);
    state.plugins.remember_source(&lease.id, None);
    if let Some(mut host) = instance.host.take() {
        host.kill();
    }
    instance.wasm = None;
    instance.node_source = None;
    instance.status = super::PluginStatus::Failed;
    instance.error = Some("plugin.frontend.activationFailed".into());
    let info = instance.info();
    state.plugins.remember(&info);
    drop(instance);
    use tauri::Emitter;
    let _ = app.emit(super::STATE_EVENT, &info);
    tracing::warn!(plugin_id = %lease.id, stage = "frontend-activation", "plugin frontend activation failed");
    Ok(info)
}

#[tauri::command]
pub async fn plugin_frontend_call(
    app: AppHandle,
    token: String,
    method: String,
    params: Value,
) -> AppResult<Value> {
    let lease = app.state::<Registry>().lease(&token)?;
    let state = app.state::<AppState>();
    authorized(&state.plugins.security, &lease)?;
    let context = HostContext {
        app: app.clone(),
        id: lease.id.clone(),
        fingerprint: lease.fingerprint.clone(),
        permissions: lease.permissions.clone(),
        generation: lease.generation,
        tool_client: None,
        tool_request: None,
    };
    let result = state
        .plugins
        .security
        .guard(&lease, super::api::dispatch(&context, &method, params))
        .await?;
    if app.state::<Registry>().lease(&token)?.generation != lease.generation {
        return Err(AppError::validation("plugin.frontend.expired"));
    }
    Ok(result)
}

fn asset_path(path: &str) -> Option<(&str, &str)> {
    let (token, asset) = path.strip_prefix('/')?.split_once('/')?;
    if uuid::Uuid::parse_str(token).is_err()
        || asset.is_empty()
        || asset.split('/').any(|part| {
            part.is_empty()
                || matches!(part, "." | "..")
                || !part
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
        })
    {
        return None;
    }
    Some((token, asset))
}

fn mime(path: &str) -> Option<&'static str> {
    Some(match path.rsplit('.').next()? {
        "mjs" | "js" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "woff2" => "font/woff2",
        _ => return None,
    })
}

pub fn serve(
    registry: &Registry,
    security: &PluginSecurity,
    request: http::Request<Vec<u8>>,
    origin: &str,
) -> http::Response<Vec<u8>> {
    let response = |status, body: Vec<u8>, mime: &str| {
        http::Response::builder()
            .status(status)
            .header("Access-Control-Allow-Origin", origin)
            .header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
            .header("Cache-Control", "no-store")
            .header("X-Content-Type-Options", "nosniff")
            .header("Content-Type", mime)
            .body(body)
            .expect("fixed response headers")
    };
    if request.method() == http::Method::OPTIONS {
        return response(204, vec![], "text/plain");
    }
    if !matches!(*request.method(), http::Method::GET | http::Method::HEAD) {
        return response(405, vec![], "text/plain");
    }
    let Some((token, asset)) = asset_path(request.uri().path()) else {
        return response(404, vec![], "text/plain");
    };
    let Some(mime) = mime(asset) else {
        return response(415, vec![], "text/plain");
    };
    let modules = registry.modules.lock().unwrap_or_else(|e| e.into_inner());
    let Some(module) = modules.get(token) else {
        return response(410, vec![], "text/plain");
    };
    if authorized(security, &module.lease).is_err() {
        return response(403, vec![], "text/plain");
    }
    let Some(bytes) = module.assets.get(asset) else {
        return response(404, vec![], "text/plain");
    };
    response(
        200,
        if request.method() == http::Method::HEAD {
            vec![]
        } else {
            bytes.to_vec()
        },
        mime,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protocol_capacity_is_reserved_before_allocating_and_recovers_on_release() {
        let registry = Registry::default();
        let mut permits: Vec<_> = (0..16).map(|_| registry.request().unwrap()).collect();
        assert!(registry.request().is_none());
        permits.pop();
        assert!(registry.request().is_some());
    }

    #[test]
    fn incompatible_sdk_error_retains_required_and_available_versions() {
        let manifest = FrontendManifest {
            entry: "ui/index.mjs".into(),
            sdk: "^2.0.0".into(),
        };
        let error = serde_json::to_value(manifest.require_sdk().unwrap_err()).unwrap();
        assert_eq!(error["code"], "validation");
        assert_eq!(error["message"], "plugin.frontend.sdkUnsupported");
        assert_eq!(error["details"]["required"], "^2.0.0");
        assert_eq!(error["details"]["available"], UI_SDK_VERSION);
    }

    #[test]
    fn paths_allow_only_bounded_local_modules_and_assets() {
        let token = uuid::Uuid::new_v4();
        assert_eq!(
            asset_path(&format!("/{token}/nested/index.mjs")).unwrap().1,
            "nested/index.mjs"
        );
        for path in [
            format!("/{token}/../secret.mjs"),
            format!("/{token}/%2e%2e/secret.mjs"),
            format!("/{token}//index.mjs"),
            format!("/{token}/x\\index.mjs"),
            "/not-token/index.mjs".into(),
        ] {
            assert!(asset_path(&path).is_none(), "{path}");
        }
        assert!(mime("page.html").is_none());
        assert_eq!(mime("index.mjs"), Some("text/javascript; charset=utf-8"));
    }

    #[test]
    fn registry_serves_only_approved_snapshots_and_revokes_old_module_urls() {
        let db = crate::db::Database::in_memory().unwrap();
        let security = PluginSecurity::default();
        let digest = "a".repeat(64);
        let permissions = vec!["ui.trusted".into()];
        security
            .set_permissions(
                &db,
                "sample",
                digest.clone(),
                &permissions,
                Some(permissions.clone()),
            )
            .unwrap();
        let lease = security
            .lease("sample", digest.clone(), permissions)
            .unwrap();
        let snapshot = || FrontendSnapshot {
            digest: digest.clone(),
            assets: BTreeMap::from([(
                "index.mjs".into(),
                Arc::from(b"export const approved=true".as_slice()),
            )]),
            bytes: 26,
        };
        let registry = Registry::default();
        let (token, _) = registry
            .insert(lease.clone(), snapshot(), |l| authorized(&security, l))
            .unwrap();
        let request = |token: &str, method: &str| {
            http::Request::builder()
                .method(method)
                .uri(format!("http://tunnelde-ui.localhost/{token}/index.mjs"))
                .body(vec![])
                .unwrap()
        };
        let reply = serve(
            &registry,
            &security,
            request(&token, "GET"),
            "http://tauri.localhost",
        );
        assert_eq!(reply.status(), 200);
        assert_eq!(reply.headers()["Cache-Control"], "no-store");
        assert_eq!(reply.body(), b"export const approved=true");
        assert!(serve(
            &registry,
            &security,
            request(&token, "HEAD"),
            "http://tauri.localhost"
        )
        .body()
        .is_empty());
        assert_eq!(
            serve(
                &registry,
                &security,
                request(&token, "POST"),
                "http://tauri.localhost"
            )
            .status(),
            405
        );
        let (next, _) = registry
            .insert(lease.clone(), snapshot(), |l| authorized(&security, l))
            .unwrap();
        assert_eq!(
            serve(
                &registry,
                &security,
                request(&token, "GET"),
                "http://tauri.localhost"
            )
            .status(),
            410
        );
        security.invalidate_runtime("sample");
        assert_eq!(
            serve(
                &registry,
                &security,
                request(&next, "GET"),
                "http://tauri.localhost"
            )
            .status(),
            403
        );
        registry.remove("sample", |g| g <= lease.generation);
        assert!(registry.lease(&next).is_err());
    }
}
