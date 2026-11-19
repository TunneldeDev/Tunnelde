//! View-local transports never replace the singleton activation token. This is
//! still a coordinator-only command: native panel/document admission is a
//! separate gateway, not a reason to grant satellites raw plugin IPC.
use super::{authorized, FrontendSession, Module, Registry, UI_SDK_VERSION};
use crate::{
    error::{AppError, AppResult},
    plugins::security::{Lease, RuntimeRetirement},
    state::AppState,
};
use tauri::{AppHandle, Manager, State};

const MAX_PER_ACTIVATION: usize = 16;
const MAX_TOTAL: usize = 64;

pub(super) struct ViewOwner {
    activation: String,
    instance: uuid::Uuid,
    view_id: String,
}

impl Registry {
    pub(super) fn with_activation<T>(
        &self,
        token: &str,
        operation: impl FnOnce(&Lease) -> AppResult<T>,
    ) -> AppResult<T> {
        let modules = self.modules.lock().unwrap_or_else(|e| e.into_inner());
        let module = modules
            .get(token)
            .filter(|module| module.view.is_none())
            .ok_or_else(|| AppError::validation("plugin.frontend.expired"))?;
        operation(&module.lease)
    }

    fn open_view(
        &self,
        activation: &str,
        instance: uuid::Uuid,
        view_id: &str,
        valid: impl FnOnce(&Lease) -> AppResult<()>,
    ) -> AppResult<(String, Vec<String>)> {
        let mut modules = self.modules.lock().unwrap_or_else(|e| e.into_inner());
        let module = modules
            .get(activation)
            .filter(|module| module.view.is_none())
            .ok_or_else(|| AppError::validation("plugin.frontend.expired"))?;
        valid(&module.lease)?;
        let lease = module.lease.clone();
        let assets = module.assets.clone();
        // Bound token/request bookkeeping separately from immutable asset bytes.
        // Reopening one exact mounted instance only retires that instance.
        let mut own = 0;
        let mut total = 0;
        let mut replaced = Vec::new();
        for (token, module) in modules.iter() {
            let Some(view) = &module.view else { continue };
            if view.activation == activation && view.instance == instance {
                if view.view_id != view_id {
                    return Err(AppError::validation("plugin.frontend.expired"));
                }
                replaced.push(token.clone());
            } else {
                total += 1;
                own += usize::from(view.activation == activation);
            }
        }
        if total >= MAX_TOTAL || own >= MAX_PER_ACTIVATION {
            return Err(AppError::validation("plugin.frontend.busy"));
        }
        let token = uuid::Uuid::new_v4().to_string();
        for old in &replaced {
            modules.remove(old);
            self.calls.retire(old);
        }
        modules.insert(
            token.clone(),
            Module {
                lease,
                view: Some(ViewOwner {
                    activation: activation.into(),
                    instance,
                    view_id: view_id.into(),
                }),
                assets,
                bytes: 0,
            },
        );
        Ok((token, replaced))
    }

    pub(super) fn close(
        &self,
        token: &str,
        closed: impl FnOnce(&Lease, &str) -> Vec<RuntimeRetirement>,
    ) -> (Vec<String>, Vec<RuntimeRetirement>) {
        let mut modules = self.modules.lock().unwrap_or_else(|e| e.into_inner());
        let Some(module) = modules.remove(token) else {
            self.calls.retire(token);
            return (vec![], vec![]);
        };
        self.calls.retire(token);
        let mut tokens = vec![token.to_owned()];
        if module.view.is_some() {
            return (tokens, vec![]);
        }
        modules.retain(|view_token, module| {
            let keep = !module
                .view
                .as_ref()
                .is_some_and(|view| view.activation == token);
            if !keep {
                self.calls.retire(view_token);
                tokens.push(view_token.clone());
            }
            keep
        });
        (tokens, closed(&module.lease, token))
    }
}

#[tauri::command]
pub async fn plugin_frontend_view_open(
    app: AppHandle,
    registry: State<'_, Registry>,
    token: String,
    instance_id: String,
    view_id: String,
) -> AppResult<FrontendSession> {
    let instance = uuid::Uuid::parse_str(&instance_id)
        .map_err(|_| AppError::validation("plugin.frontend.expired"))?;
    let lease = registry.with_activation(&token, |lease| Ok(lease.clone()))?;
    let state = app.state::<AppState>();
    let owner = state.plugins.admit_invocation(&lease.id, &lease).await?;
    if owner.retired || owner.status != crate::plugins::PluginStatus::Running {
        return Err(AppError::validation("plugin.notRunning"));
    }
    if !owner
        .manifest
        .views
        .iter()
        .any(|view| view.id == view_id && view.kind.as_deref() == Some("component"))
    {
        return Err(AppError::validation(
            "plugin.frontend.undeclaredContribution",
        ));
    }
    let frontend = owner
        .manifest
        .frontend
        .as_ref()
        .ok_or_else(|| AppError::validation("plugin.frontend.unavailable"))?;
    let (view_token, replaced) = registry.open_view(&token, instance, &view_id, |lease| {
        authorized(&state.plugins.security, lease)?;
        if !state.plugins.security.is_ready(lease)? {
            return Err(AppError::validation("plugin.notRunning"));
        }
        Ok(())
    })?;
    for old in replaced {
        crate::plugins::forwarding::remove_token(&app, &old);
    }
    Ok(FrontendSession {
        token: view_token,
        plugin_id: lease.id.clone(),
        generation: lease.generation,
        runtime_id: state.plugins.security.lease_stamp(&lease),
        entry: frontend.entry.trim_start_matches("ui/").into(),
        sdk_version: UI_SDK_VERSION,
    })
}

#[cfg(test)]
mod tests;
