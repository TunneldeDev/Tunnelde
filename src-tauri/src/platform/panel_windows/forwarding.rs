//! Private native forwarding ingress. No arbitrary invoke, raw provider bearer
//! authority or caller-chosen native identity. Start credentials stay request-local; they
//! never enter capsules/read models. Transfer admission is separate.
mod clipboard;
mod connection;
pub(super) mod diagnostics;
pub(super) mod provider;
pub(super) mod request;
use super::{
    native,
    ownership::{Lease, Ownership},
};
use crate::services::operations::{Authority, WorkLifetime};
use crate::{
    error::{AppError, AppResult},
    services::forwarding as domain,
    state::AppState,
};
use request::Request;
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::{AppHandle, Manager, WebviewWindow};

impl Ownership {
    fn forwarding_current(
        &self,
        window: &str,
        document: &str,
        lease: &Lease,
        request: &Request,
    ) -> Result<(), &'static str> {
        self.forwarding_scope_current(window, document, lease, request.interaction())
    }
    fn forwarding_scope_current(
        &self,
        window: &str,
        document: &str,
        lease: &Lease,
        interaction: Option<&str>,
    ) -> Result<(), &'static str> {
        if lease.panel_id != "forwarding" {
            return Err("unsupported panel action");
        }
        self.resource_action(window, document, lease)?;
        if let Some(interaction) = interaction {
            self.require_interaction(window, document, lease, interaction)?;
        }
        Ok(())
    }
    fn begin_forwarding(
        &mut self,
        window: &str,
        document: &str,
        lease: &Lease,
        request: &Request,
    ) -> Result<String, &'static str> {
        self.begin_forwarding_scoped(window, document, lease, request, None)
    }
    fn begin_forwarding_scoped(
        &mut self,
        window: &str,
        document: &str,
        lease: &Lease,
        request: &Request,
        provider: Option<&str>,
    ) -> Result<String, &'static str> {
        request.validate()?;
        self.forwarding_current(window, document, lease, request)?;
        // One actual operation per panel, independent of JS response delivery.
        if !self.panels[&lease.panel_id].native_actions.is_empty() {
            return Err("panel action in progress");
        }
        let id = uuid::Uuid::new_v4().to_string();
        self.relay_fence(&lease.panel_id, &id, true)?;
        if let Request::Test {
            test_id,
            interaction,
            ..
        } = request
        {
            let scope =
                diagnostics::Scope::new(window, document, lease, interaction).provider(provider);
            if let Err(error) = self.begin_forwarding_test(test_id, scope, &id) {
                self.finish_native_action(&lease.panel_id, &id);
                return Err(error);
            }
        }
        Ok(id)
    }
}

struct Effect {
    app: AppHandle,
    window: String,
    document: String,
    lease: Lease,
    id: String,
    interaction: Option<String>,
    provider: Option<provider::Provider>,
    settled: Option<tokio::sync::oneshot::Sender<()>>,
}
impl Effect {
    fn with_current<T>(&self, run: impl FnOnce() -> AppResult<T>) -> AppResult<T> {
        self.with_ownership(|_| run())
    }
    fn with_ownership<T>(&self, run: impl FnOnce(&mut Ownership) -> AppResult<T>) -> AppResult<T> {
        let registry = self.app.state::<native::Registry>();
        let mut ownership = native::lock(&registry);
        ownership
            .forwarding_scope_current(
                &self.window,
                &self.document,
                &self.lease,
                self.interaction.as_deref(),
            )
            .map_err(native::invalid)?;
        if !ownership.panels[&self.lease.panel_id]
            .native_actions
            .contains(&self.id)
        {
            return Err(native::invalid("panel action expired"));
        }
        ownership
            .forwarding_tests
            .check_action(&self.id)
            .map_err(native::invalid)?;
        // Ownership -> optional module/policy/selection -> automation -> registry
        // -> DB. No awaits,
        // native UI or calls back into ownership inside this transaction.
        if let Some(provider) = &self.provider {
            provider
                .authority
                .check_binding(&ownership, (&self.window, &self.document), &self.lease)
                .map_err(native::invalid)?;
            provider.with_current(&self.app, || run(&mut ownership))
        } else {
            run(&mut ownership)
        }
    }
    fn plugin_owner(&self) -> Option<(String, u64)> {
        self.provider
            .as_ref()
            .map(|provider| provider.authority.owner())
    }
}
impl Authority for Effect {
    fn with_current(&self, effect: &mut dyn FnMut() -> AppResult<()>) -> AppResult<()> {
        self.with_current(effect)
    }
}
impl Drop for Effect {
    fn drop(&mut self) {
        native::lock(&self.app.state::<native::Registry>())
            .finish_forwarding_action(&self.lease.panel_id, &self.id);
        native::changed(&self.app);
        if let Some(settled) = self.settled.take() {
            let _ = settled.send(());
        }
    }
}

#[tauri::command]
pub(crate) async fn panel_window_forwarding(
    window: WebviewWindow,
    document: String,
    lease: Lease,
    request: Request,
) -> AppResult<Value> {
    dispatch(
        window.app_handle().clone(),
        window.label(),
        document,
        lease,
        request,
        None,
    )
    .await
}
async fn dispatch(
    app: AppHandle,
    window: &str,
    document: String,
    lease: Lease,
    request: Request,
    provider_token: Option<String>,
) -> AppResult<Value> {
    // Cancellation is a scoped cleanup signal, not admission of a new effect.
    // It must remain usable while that same panel's test fence is occupied.
    if let Request::CancelTest {
        test_id,
        interaction,
    } = &request
    {
        request.validate().map_err(native::invalid)?;
        native::lock(&app.state::<native::Registry>())
            .cancel_forwarding_test(
                test_id,
                diagnostics::Scope::new(window, &document, &lease, interaction)
                    .provider(provider_token.as_deref()),
            )
            .map_err(native::invalid)?;
        return Ok(Value::Null);
    }
    request.validate().map_err(native::invalid)?;
    let (id, provider) = {
        let registry = app.state::<native::Registry>();
        let mut ownership = native::lock(&registry);
        let provider = provider_token
            .as_deref()
            .map(|token| {
                provider::Provider::capture(
                    &ownership,
                    (window, &document),
                    &lease,
                    token,
                    &request,
                )
            })
            .transpose()?;
        let id = if let Some(provider) = &provider {
            provider.with_current(&app, || {
                ownership
                    .begin_forwarding_scoped(
                        window,
                        &document,
                        &lease,
                        &request,
                        Some(provider.authority.token()),
                    )
                    .map_err(native::invalid)
            })?
        } else {
            ownership
                .begin_forwarding(window, &document, &lease, &request)
                .map_err(native::invalid)?
        };
        (id, provider)
    };
    let (settled, settlement) = tokio::sync::oneshot::channel();
    let effect = Arc::new(Effect {
        app: app.clone(),
        window: window.into(),
        document,
        lease,
        id,
        interaction: request.interaction().map(str::to_owned),
        provider,
        settled: Some(settled),
    });
    native::changed(&app);
    // Move the actual-effect guard INSIDE the worker. Dropping IPC delivery or
    // reloading the coordinator cannot unlock a still-running native operation.
    let work = WorkLifetime::authorized(effect.clone());
    let result = tauri::async_runtime::spawn(work.scope(async move {
        match request {
            Request::CopyAddress { text } => clipboard::copy(effect, text).await,
            Request::Disconnect {
                host_id,
                session_id,
                ..
            } => disconnect(effect, host_id, session_id).await,
            Request::PrepareStart { id, revision, .. } => {
                connection::prepare(effect, id, revision).await
            }
            Request::InstallKey {
                id,
                revision,
                review,
                password,
                credentials,
                ..
            } => connection::install_key(effect, id, revision, review, password, credentials).await,
            Request::Test {
                id,
                revision,
                review,
                test_id,
                credentials,
                ..
            } => diagnostics::run(effect, id, revision, review, test_id, credentials).await,
            Request::Start {
                id,
                revision,
                review,
                credentials,
                ..
            } => connection::start(effect, id, revision, review, credentials).await,
            Request::Probe {
                id,
                revision,
                review,
                credentials,
                ..
            } => connection::probe(effect, id, revision, review, credentials, None).await,
            Request::Trust {
                id,
                revision,
                review,
                credentials,
                fingerprint,
                expected_host_id,
                ..
            } => {
                connection::probe(
                    effect,
                    id,
                    revision,
                    review,
                    credentials,
                    Some((fingerprint, expected_host_id)),
                )
                .await
            }
            Request::CredentialStatus {
                id,
                revision,
                review,
                host_id,
                ..
            } => {
                connection::credential(
                    effect,
                    id,
                    revision,
                    review,
                    host_id,
                    connection::CredentialAction::Status,
                )
                .await
            }
            Request::SaveCredential {
                id,
                revision,
                review,
                host_id,
                password,
                ..
            } => {
                connection::credential(
                    effect,
                    id,
                    revision,
                    review,
                    host_id,
                    connection::CredentialAction::Save(password),
                )
                .await
            }
            Request::ForgetCredential {
                id,
                revision,
                review,
                host_id,
                ..
            } => {
                connection::credential(
                    effect,
                    id,
                    revision,
                    review,
                    host_id,
                    connection::CredentialAction::Forget,
                )
                .await
            }
            request => {
                let current = effect.clone();
                // Blocking jobs inherit both lifetime and short authority, but
                // keep slow OS observations outside the ownership lock.
                let prepared = crate::services::credentials::inspect(move || {
                    current.with_current(|| prepare(&current.app, &request))
                })
                .await?;
                match prepared {
                    Prepared::Value(value) => Ok(value),
                    Prepared::Stop(stopping) => {
                        domain::automation::changed(&effect.app);
                        WorkLifetime::current()
                            .retirement()
                            .scope(stopping.finish())
                            .await
                            .map(|()| Value::Null)
                    }
                }
            }
        }
    }))
    .await
    .map_err(|_| AppError::internal("forward.invalid"))?;
    // A successful listener shutdown may retire its final pooled transport on
    // a descendant worker. Do not acknowledge completion before that same
    // effect fence has actually left the registry. IPC cancellation drops only
    // this receiver; descendants still own the guard and continue cleanup.
    settlement
        .await
        .map_err(|_| AppError::internal("forward.invalid"))?;
    result
}

async fn disconnect(effect: Arc<Effect>, host: String, session: String) -> AppResult<Value> {
    let current = effect.clone();
    let stopping = crate::services::credentials::inspect(move || {
        current.with_current(|| domain::disconnect::take(&current.app, &host, &session))
    })
    .await?;
    // Detachment was admitted atomically under original consent. All later
    // work retires only those exact handles; it cannot need replacement consent.
    WorkLifetime::current()
        .retirement()
        .scope(stopping.finish())
        .await?;
    Ok(Value::Null)
}

enum Prepared {
    Value(Value),
    Stop(crate::ssh::forward::StoppedForward),
}
fn prepare(app: &AppHandle, request: &Request) -> AppResult<Prepared> {
    let state = app.state::<AppState>();
    let value = match request {
        Request::CopyAddress { .. }
        | Request::Disconnect { .. }
        | Request::Start { .. }
        | Request::PrepareStart { .. }
        | Request::Probe { .. }
        | Request::CredentialStatus { .. }
        | Request::SaveCredential { .. }
        | Request::ForgetCredential { .. }
        | Request::InstallKey { .. }
        | Request::Test { .. }
        | Request::CancelTest { .. }
        | Request::Trust { .. } => return Err(AppError::validation("forward.invalid")),
        Request::Save {
            rule,
            revision,
            group_id,
            automation,
            ..
        } => {
            let entry = domain::save_grouped(
                app,
                rule.clone(),
                revision.as_deref(),
                *automation,
                group_id.as_deref(),
            )?;
            domain::automation::changed(app);
            json!(domain::automation::ConfiguredRule {
                entry,
                automation: *automation
            })
        }
        Request::Stop {
            id,
            revision,
            runtime_id,
        } => {
            return Ok(Prepared::Stop(domain::take_manual_stop(
                app,
                id,
                revision,
                runtime_id.as_deref(),
            )?));
        }
        Request::Remove {
            id,
            revision,
            runtime_id,
            ..
        } => {
            return Ok(Prepared::Stop(domain::take_manual_remove(
                app,
                id,
                revision,
                runtime_id.as_deref(),
            )?));
        }
        Request::SaveGroup {
            host_id,
            name,
            id,
            revision,
        } => {
            let group = state.db.with(|conn| {
                crate::db::atomic(conn, |conn| {
                    domain::groups::save_at(conn, id.as_deref(), host_id, name, revision.as_deref())
                })
            })?;
            domain::automation::changed(app);
            json!(group)
        }
        Request::RemoveGroup { id, revision } => {
            domain::groups::remove(&state.db, &state.forwards, id, revision)?;
            domain::automation::changed(app);
            Value::Null
        }
    };
    Ok(Prepared::Value(value))
}

#[cfg(test)]
mod tests;
