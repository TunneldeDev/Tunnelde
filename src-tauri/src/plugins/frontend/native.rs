//! Private half of the document/panel gateway. Never serialize activation
//! credentials or accept them from a satellite. No second runtime is started.
mod policy;
mod provider;
use super::{authorized, FrontendSession, Registry, UI_SDK_VERSION};
use crate::{
    error::{AppError, AppResult},
    plugins::{api::HostContext, security::Lease, PluginStatus},
    state::AppState,
};
pub(crate) use policy::{call_policy, CallPolicy};
pub(crate) use provider::{
    selected_forwarding_source, selected_hosts_source, selected_preview_source,
    selected_tasks_source, ProviderSelection,
};
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
    provider: Option<ProviderSelection>,
}
pub(crate) async fn source(
    app: &AppHandle,
    plugin: &str,
    runtime: &str,
    view: &str,
) -> AppResult<Source> {
    source_for(app, plugin, runtime, view, None).await
}
async fn source_for(
    app: &AppHandle,
    plugin: &str,
    runtime: &str,
    view: &str,
    provider: Option<ProviderSelection>,
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
                && match &provider {
                    None => v.location.as_deref() == Some("sidebar") && v.provider.is_none(),
                    Some(selection) => v.provider.as_deref() == Some(selection.target()),
                }
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
        provider,
    })
}
impl Source {
    pub(crate) fn same_module(&self, other: &Self) -> bool {
        self.lease == other.lease
            && self.activation == other.activation
            && self.descriptor() == other.descriptor()
            && self.provider == other.provider
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
        self.with_permissions(app, &[], operation)
    }
    /// Only pure short resource callbacks: this holds module/policy/selection.
    /// Never reenter frontend/security or perform OS/network I/O inside it.
    pub(crate) fn with_permissions<T>(
        &self,
        app: &AppHandle,
        permissions: &[&str],
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
        self.with_policy(app, permissions, operation)
    }
    pub(crate) fn provider_selection(&self) -> Option<&ProviderSelection> {
        self.provider.as_ref()
    }
    fn with_policy<T>(
        &self,
        app: &AppHandle,
        additional: &[&str],
        operation: impl FnOnce() -> AppResult<T>,
    ) -> AppResult<T> {
        let state = app.state::<AppState>();
        let permissions = self
            .provider
            .as_ref()
            .map(|p| p.permissions())
            .unwrap_or(&["ui.trusted"]);
        let permissions: Vec<_> = permissions.iter().chain(additional).copied().collect();
        state
            .plugins
            .security
            .with_authorized(&self.lease, &permissions, || {
                if let Some(provider) = &self.provider {
                    let settings = state.settings.read().unwrap_or_else(|e| e.into_inner());
                    provider.check(
                        &settings,
                        state
                            .ui_provider_revision
                            .load(std::sync::atomic::Ordering::SeqCst),
                        &self.lease.id,
                        &self.view_id,
                    )?;
                    operation()
                } else {
                    operation()
                }
            })
    }
    #[cfg(test)]
    pub(crate) fn test_preview_source(lease: Lease, revision: u64) -> Self {
        let mut source = Self::test_source(lease, "runtime", "preview", true, "private-singleton");
        source.provider = Some(ProviderSelection::test_preview_selection(revision));
        source
    }
    #[cfg(test)]
    pub(crate) fn test_hosts_source(lease: Lease, revision: u64) -> Self {
        let mut source = Self::test_source(lease, "runtime", "hosts", true, "private-singleton");
        source.provider = Some(ProviderSelection::test_hosts_selection(revision));
        source
    }
    #[cfg(test)]
    pub(crate) fn test_tasks_source(lease: Lease, revision: u64) -> Self {
        let mut source = Self::test_source(lease, "runtime", "tasks", true, "private-singleton");
        source.provider = Some(ProviderSelection::test_tasks_selection(revision));
        source
    }
    #[cfg(test)]
    pub(crate) fn test_forwarding_source(lease: Lease, revision: u64) -> Self {
        let mut source = Self::test_source(lease, "runtime", "forwards", true, "private-singleton");
        source.provider = Some(ProviderSelection::test_selection(revision));
        source
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
            provider: None,
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
            source.with_policy(app, &[], || Ok(()))?;
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
        // The domain dispatcher contains every resource future. Do not inline
        // its large state machine through request/origin/effect scopes: native
        // Tokio workers have bounded stacks, including in debug builds.
        let work = Box::pin(crate::plugins::api::dispatch(&context, method, params));
        let result = if self.policy.retained() {
            self.lifetime.run_retained(work).await?
        } else {
            self.lifetime.run(work).await?
        };
        with_owner(app, &self.token, &self.owner, || Ok(result))
    }
}

#[cfg(test)]
mod future_size_tests {
    use super::*;
    #[test]
    fn native_request_future_stays_bounded_when_wrapped_in_origin_and_effect_scopes() {
        fn size<F: std::future::Future>(
            _: impl FnOnce(NativeCall, &'static AppHandle, &'static str, Value) -> F,
        ) -> usize {
            std::mem::size_of::<F>()
        }
        let size = size(NativeCall::run);
        assert!(size < 16 * 1024, "native request future is {size} bytes");
    }
}
