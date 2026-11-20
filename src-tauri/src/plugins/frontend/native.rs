//! Private half of the document/panel gateway. Never serialize activation
//! credentials or accept them from a satellite. No second runtime is started.
mod policy;
use super::{authorized, FrontendSession, Registry, UI_SDK_VERSION};
use crate::{
    error::{AppError, AppResult},
    plugins::{api::HostContext, security::Lease, PluginStatus},
    state::AppState,
};
pub(crate) use policy::{call_policy, CallPolicy};
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager};

/// Display/module identity only. This is NOT a bearer capability. The native
/// gateway still opens each attachment against its exact document and lease.
#[derive(Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ViewDescriptor {
    pub(crate) plugin_id: String,
    pub(crate) generation: u64,
    pub(crate) runtime_id: String,
    pub(crate) view_id: String,
    pub(crate) entry: String,
    pub(crate) sdk_version: &'static str,
    pub(crate) title: String,
    pub(crate) allow_floating: bool,
}
#[derive(Clone)]
pub(crate) struct Source {
    pub(crate) lease: Lease,
    activation: String,
    view_id: String,
    entry: String,
    runtime_id: String,
    title: String,
    allow_floating: bool,
}
pub(crate) async fn source(
    app: &AppHandle,
    plugin: &str,
    runtime: &str,
    view: &str,
) -> AppResult<Source> {
    let state = app.state::<AppState>();
    let lease = state.plugins.invocation_lease(plugin, runtime)?;
    let owner = state.plugins.admit_invocation(plugin, &lease).await?;
    if owner.retired || owner.status != PluginStatus::Running {
        return Err(AppError::validation("plugin.notRunning"));
    }
    // Provider contracts own native handles and synchronous slot validation.
    // They must not accidentally enter the generic sidebar transport.
    let contribution = owner
        .manifest
        .views
        .iter()
        .find(|v| {
            v.id == view
                && v.kind.as_deref() == Some("component")
                && v.location.as_deref() == Some("sidebar")
                && v.provider.is_none()
        })
        .ok_or_else(|| AppError::validation("plugin.frontend.undeclaredContribution"))?;
    let entry = owner
        .manifest
        .frontend
        .as_ref()
        .ok_or_else(|| AppError::validation("plugin.frontend.unavailable"))?
        .entry
        .trim_start_matches("ui/")
        .to_owned();
    let registry = app.state::<Registry>();
    let modules = registry.modules.lock().unwrap_or_else(|e| e.into_inner());
    let activation = modules
        .iter()
        .find(|(_, m)| m.view.is_none() && m.lease == lease)
        .map(|(token, _)| token.clone())
        .ok_or_else(|| AppError::validation("plugin.frontend.expired"))?;
    authorized(&state.plugins.security, &lease)?;
    if !state.plugins.security.is_ready(&lease)? {
        return Err(AppError::validation("plugin.notRunning"));
    }
    Ok(Source {
        lease,
        activation,
        view_id: view.into(),
        entry,
        runtime_id: runtime.into(),
        title: contribution.title.clone(),
        allow_floating: contribution.allow_floating != Some(false),
    })
}
impl Source {
    pub(crate) fn same_module(&self, other: &Self) -> bool {
        self.lease == other.lease
            && self.activation == other.activation
            && self.descriptor() == other.descriptor()
    }
    pub(crate) fn descriptor(&self) -> ViewDescriptor {
        ViewDescriptor {
            plugin_id: self.lease.id.clone(),
            generation: self.lease.generation,
            runtime_id: self.runtime_id.clone(),
            view_id: self.view_id.clone(),
            entry: self.entry.clone(),
            sdk_version: UI_SDK_VERSION,
            title: self.title.clone(),
            allow_floating: self.allow_floating,
        }
    }
    /// Ownership -> module -> security, the same order as opening a view. Keep
    /// the final policy check and admission in one transaction after async review.
    pub(crate) fn with_current<T>(
        &self,
        app: &AppHandle,
        operation: impl FnOnce() -> AppResult<T>,
    ) -> AppResult<T> {
        let registry = app.state::<Registry>();
        let modules = registry.modules.lock().unwrap_or_else(|e| e.into_inner());
        let module = modules
            .get(&self.activation)
            .filter(|m| m.view.is_none() && m.lease == self.lease)
            .ok_or_else(|| AppError::validation("plugin.frontend.expired"))?;
        if !app
            .state::<AppState>()
            .plugins
            .security
            .is_ready(&module.lease)?
        {
            return Err(AppError::validation("plugin.notRunning"));
        }
        app.state::<AppState>().plugins.security.with_authorized(
            &module.lease,
            &["ui.trusted"],
            operation,
        )
    }
    #[cfg(test)]
    pub(crate) fn test_source(
        lease: Lease,
        runtime: &str,
        view: &str,
        floating: bool,
        activation: &str,
    ) -> Self {
        Self {
            lease,
            activation: activation.into(),
            view_id: view.into(),
            entry: "index.js".into(),
            runtime_id: runtime.into(),
            title: "Sample files".into(),
            allow_floating: floating,
        }
    }
}
impl Registry {
    pub(super) fn is_native_view(&self, token: &str) -> bool {
        self.modules
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(token)
            .is_some_and(|m| m.view.as_ref().is_some_and(|v| v.native))
    }
    fn with_native_lease<T>(
        &self,
        token: &str,
        operation: impl FnOnce(&Lease) -> AppResult<T>,
    ) -> AppResult<T> {
        let modules = self.modules.lock().unwrap_or_else(|e| e.into_inner());
        let module = modules
            .get(token)
            .filter(|m| m.view.as_ref().is_some_and(|v| v.native))
            .ok_or_else(|| AppError::validation("plugin.frontend.expired"))?;
        operation(&module.lease)
    }
}
/// The caller holds native ownership; opening the child and recording its
/// document binding happen in that same transaction, after asynchronous review.
pub(crate) fn open(app: &AppHandle, source: Source) -> AppResult<FrontendSession> {
    let registry = app.state::<Registry>();
    let state = app.state::<AppState>();
    let (token, _) = registry.open_scoped_view(
        &source.activation,
        uuid::Uuid::new_v4(),
        &source.view_id,
        true,
        |lease| {
            if *lease != source.lease {
                return Err(AppError::validation("plugin.frontend.expired"));
            }
            authorized(&state.plugins.security, lease)?;
            if !state.plugins.security.is_ready(lease)? {
                return Err(AppError::validation("plugin.notRunning"));
            }
            Ok(())
        },
    )?;
    Ok(FrontendSession {
        token,
        plugin_id: source.lease.id,
        generation: source.lease.generation,
        runtime_id: source.runtime_id,
        entry: source.entry,
        sdk_version: UI_SDK_VERSION,
    })
}
pub(crate) fn with_owner<T>(
    app: &AppHandle,
    token: &str,
    owner: &Lease,
    operation: impl FnOnce() -> AppResult<T>,
) -> AppResult<T> {
    with_owner_permissions(app, token, owner, &[], operation)
}
/// Caller holds native ownership. Acquire module -> policy once for both the
/// trusted view and the endpoint's extra authority. Never reenter security from
/// `operation`; consent insertion and final delivery belong inside this gate.
pub(crate) fn with_owner_permissions<T>(
    app: &AppHandle,
    token: &str,
    owner: &Lease,
    permissions: &[&str],
    operation: impl FnOnce() -> AppResult<T>,
) -> AppResult<T> {
    let permissions: Vec<_> = std::iter::once("ui.trusted")
        .chain(permissions.iter().copied())
        .collect();
    app.state::<Registry>().with_native_lease(token, |lease| {
        if lease != owner {
            return Err(AppError::validation("plugin.frontend.expired"));
        }
        app.state::<AppState>()
            .plugins
            .security
            .with_authorized(lease, &permissions, operation)
    })
}
pub(crate) fn close(app: &AppHandle, tokens: Vec<String>) {
    let registry = app.state::<Registry>();
    for token in tokens {
        // No provider scope is admitted with a native token. Do not route this
        // through singleton close, failed(), or provider resource teardown.
        if registry.is_native_view(&token) {
            registry.close(&token, |_, _| vec![]);
        }
    }
}
pub(crate) fn prepare(app: &AppHandle, token: &str, owner: &Lease) -> AppResult<String> {
    with_owner(app, token, owner, || {
        let id = uuid::Uuid::new_v4().to_string();
        app.state::<Registry>().calls.reserve(token, &id)?;
        Ok(id)
    })
}
pub(crate) fn cancel(app: &AppHandle, token: &str, request: &str) -> bool {
    app.state::<Registry>().calls.cancel(token, request)
}
pub(crate) struct NativeCall {
    lifetime: super::super::runtime::requests::Request,
    owner: Lease,
    token: String,
    policy: CallPolicy,
}
/// Claim while the gateway still holds native ownership. There must not be a
/// document reload between final view authorization and request admission.
pub(crate) fn claim(
    app: &AppHandle,
    token: &str,
    owner: &Lease,
    request: &str,
    policy: CallPolicy,
) -> AppResult<NativeCall> {
    let lifetime = with_owner(app, token, owner, || {
        app.state::<Registry>().calls.claim(token, request)
    })?;
    Ok(NativeCall {
        lifetime,
        owner: owner.clone(),
        token: token.into(),
        policy,
    })
}
impl NativeCall {
    pub(crate) async fn run(
        mut self,
        app: &AppHandle,
        method: &str,
        params: Value,
    ) -> AppResult<Value> {
        if call_policy(method) != Some(self.policy) {
            return Err(AppError::validation(
                "plugin.frontend.nativeMethodUnavailable",
            ));
        }
        let context = HostContext {
            app: app.clone(),
            id: self.owner.id.clone(),
            fingerprint: self.owner.fingerprint.clone(),
            permissions: self.owner.permissions.clone(),
            generation: self.owner.generation,
            tool_client: None,
            tool_request: None,
        };
        let work = crate::plugins::api::dispatch(&context, method, params);
        let result = if self.policy.retained() {
            self.lifetime.run_retained(work).await?
        } else {
            self.lifetime.run(work).await?
        };
        with_owner(app, &self.token, &self.owner, || Ok(result))
    }
}
