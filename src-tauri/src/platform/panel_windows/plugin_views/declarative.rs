//! Host-rendered declarative views use a distinct native descriptor. JSON,
//! `plugin:` prefixes and activation records are never renderer capabilities.
use super::super::{native, ownership::Ownership};
use crate::{
    error::{AppError, AppResult},
    plugins::{security::Lease as PluginLease, PluginStatus},
    state::AppState,
};
use serde::Serialize;
use serde_json::{json, Value};
use std::time::Instant;
use tauri::{AppHandle, Manager};

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Descriptor {
    pub(crate) panel_id: String,
    pub(crate) revision: String,
    pub(crate) plugin_id: String,
    pub(crate) runtime_id: String,
    pub(crate) generation: u64,
    pub(crate) view_id: String,
    pub(crate) title: String,
    pub(crate) allow_floating: bool,
    pub(crate) renderer: &'static str,
}
pub(super) struct Admission {
    pub(super) plugin: PluginLease,
    pub(super) runtime_id: String,
    pub(super) view_id: String,
    pub(super) title: String,
    pub(super) allow_floating: bool,
}
pub(super) struct Adapter {
    pub(super) lease: PluginLease,
    pub(super) runtime_id: String,
    pub(super) descriptor: Descriptor,
}
impl Ownership {
    pub(super) fn declarative_adapters(&self) -> Vec<Descriptor> {
        let mut list: Vec<_> = self
            .native_views
            .declarative
            .values()
            .map(|adapter| adapter.descriptor.clone())
            .collect();
        list.sort_by(|a, b| a.panel_id.cmp(&b.panel_id));
        list
    }
    pub(super) fn register_declarative_adapter(
        &mut self,
        window: &str,
        document: &str,
        admission: Admission,
    ) -> Result<(Descriptor, bool), &'static str> {
        self.main(window, document)?;
        let panel_id = format!("plugin:{}:{}", admission.plugin.id, admission.view_id);
        if admission.runtime_id.is_empty()
            || !admission.allow_floating
            || !self.panels.contains_key(&panel_id)
        {
            return Err("plugin.frontend.undeclaredContribution");
        }
        if let Some(current) = self.native_views.declarative.get(&panel_id) {
            if current.lease != admission.plugin
                || current.runtime_id != admission.runtime_id
                || current.descriptor.view_id != admission.view_id
            {
                return Err("plugin.frontend.adapterChanged");
            }
            return Ok((current.descriptor.clone(), false));
        }
        if !self.panels[&panel_id].native_actions.is_empty() {
            return Err("panel interaction in progress");
        }
        let descriptor = Descriptor {
            panel_id: panel_id.clone(),
            revision: uuid::Uuid::new_v4().to_string(),
            plugin_id: admission.plugin.id.clone(),
            runtime_id: admission.runtime_id.clone(),
            generation: admission.plugin.generation,
            view_id: admission.view_id.clone(),
            title: admission.title,
            allow_floating: admission.allow_floating,
            renderer: "json",
        };
        self.native_views.declarative.insert(
            panel_id,
            Adapter {
                lease: admission.plugin,
                runtime_id: admission.runtime_id,
                descriptor: descriptor.clone(),
            },
        );
        Ok((descriptor, true))
    }
    pub(super) fn unregister_declarative_adapter(
        &mut self,
        window: &str,
        document: &str,
        panel_id: &str,
        runtime_id: &str,
        generation: u64,
        revision: &str,
    ) -> Result<bool, &'static str> {
        self.main(window, document)?;
        let Some(adapter) = self.native_views.declarative.get(panel_id) else {
            return Ok(false);
        };
        if adapter.runtime_id != runtime_id
            || adapter.lease.generation != generation
            || adapter.descriptor.revision != revision
        {
            return Err("plugin.frontend.adapterChanged");
        }
        self.native_views.declarative.remove(panel_id);
        self.reset_plugin_panel(panel_id);
        Ok(true)
    }
    pub(super) fn retire_declarative_adapters(
        &mut self,
        retired: impl Fn(&PluginLease, &str) -> bool,
    ) -> bool {
        let ids: Vec<_> = self
            .native_views
            .declarative
            .iter()
            .filter(|(_, adapter)| retired(&adapter.lease, &adapter.runtime_id))
            .map(|(id, _)| id.clone())
            .collect();
        for id in &ids {
            self.native_views.declarative.remove(id);
            self.reset_plugin_panel(id);
        }
        !ids.is_empty()
    }
    fn declarative_target(
        &self,
        window: &str,
        document: &str,
        target: &super::Target,
        now: Instant,
    ) -> Result<(String, PluginLease), &'static str> {
        let panel_id = match target {
            super::Target::Owned { lease } => {
                self.resource_action(window, document, lease)?;
                lease.panel_id.clone()
            }
            super::Target::Staged { id } => self
                .staged(window, document, id, now)?
                .offer
                .lease
                .panel_id
                .clone(),
        };
        let adapter = self
            .native_views
            .declarative
            .get(&panel_id)
            .ok_or("plugin.frontend.undeclaredContribution")?;
        Ok((panel_id, adapter.lease.clone()))
    }
    pub(super) fn begin_declarative_model(
        &mut self,
        window: &str,
        document: &str,
        panel_id: &str,
        revision: &str,
    ) -> Result<String, &'static str> {
        self.main(window, document)?;
        if !self
            .native_views
            .declarative
            .get(panel_id)
            .is_some_and(|adapter| adapter.descriptor.revision == revision)
        {
            return Err("plugin.frontend.adapterChanged");
        }
        self.begin_model(window, document, panel_id)
    }
}

fn adapter(
    app: &AppHandle,
    caller: (&str, &str),
    target: &super::Target,
) -> AppResult<(String, PluginLease, String, String)> {
    let registry = app.state::<native::Registry>();
    let ownership = native::lock(&registry);
    let (panel_id, plugin) = ownership
        .declarative_target(caller.0, caller.1, target, Instant::now())
        .map_err(native::invalid)?;
    let current = ownership
        .native_views
        .declarative
        .get(&panel_id)
        .ok_or_else(|| AppError::validation("plugin.frontend.expired"))?;
    Ok((
        panel_id,
        plugin,
        current.runtime_id.clone(),
        current.descriptor.view_id.clone(),
    ))
}
async fn running_plugin(
    app: &AppHandle,
    plugin: &PluginLease,
    runtime_id: &str,
) -> AppResult<crate::plugins::PluginInfo> {
    let info = app
        .state::<AppState>()
        .plugins
        .list()
        .await
        .into_iter()
        .find(|info| info.id == plugin.id && info.status == PluginStatus::Running)
        .ok_or_else(|| AppError::validation("plugin.notRunning"))?;
    if info.runtime_id.as_deref() != Some(runtime_id) {
        return Err(AppError::validation("pluginSecurity.changed"));
    }
    Ok(info)
}
pub(super) fn describe(
    app: &AppHandle,
    caller: (&str, &str),
    target: &super::Target,
) -> AppResult<Value> {
    let (panel_id, _, _, _) = adapter(app, caller, target)?;
    let registry = app.state::<native::Registry>();
    let ownership = native::lock(&registry);
    Ok(json!(
        ownership.native_views.declarative[&panel_id].descriptor
    ))
}
pub(super) async fn open(
    app: &AppHandle,
    caller: (&str, &str),
    target: &super::Target,
    plugin_id: &str,
    runtime_id: &str,
    view_id: &str,
) -> AppResult<Value> {
    let (panel_id, plugin, bound_runtime, bound_view) = adapter(app, caller, target)?;
    if plugin.id != plugin_id || bound_runtime != runtime_id || bound_view != view_id {
        return Err(AppError::validation("plugin.frontend.adapterChanged"));
    }
    let info = running_plugin(app, &plugin, runtime_id).await?;
    let contribution = info
        .views
        .iter()
        .find(|view| {
            view.id == view_id
                && view.kind.as_deref() == Some("blocks")
                && view.location.as_deref() == Some("sidebar")
                && view.provider.is_none()
                && view.allow_floating != Some(false)
        })
        .ok_or_else(|| AppError::validation("plugin.frontend.undeclaredContribution"))?;
    let registry = app.state::<native::Registry>();
    let descriptor = {
        let ownership = native::lock(&registry);
        ownership.native_views.declarative[&panel_id]
            .descriptor
            .clone()
    };
    if descriptor.title != contribution.title {
        return Err(AppError::validation("plugin.frontend.adapterChanged"));
    }
    let token = uuid::Uuid::new_v4().to_string();
    {
        let mut ownership = native::lock(&registry);
        ownership
            .bind_native_view(
                caller,
                target.clone(),
                plugin.clone(),
                view_id,
                token.clone(),
                Instant::now(),
            )
            .map_err(native::invalid)?;
    }
    Ok(json!({
        "token": token,
        "pluginId": descriptor.plugin_id,
        "generation": descriptor.generation,
        "runtimeId": descriptor.runtime_id,
        "viewId": descriptor.view_id,
        "title": descriptor.title,
        "renderer": descriptor.renderer,
    }))
}
pub(super) async fn render(
    app: &AppHandle,
    caller: (&str, &str),
    target: &super::Target,
    locale: Option<String>,
) -> AppResult<Value> {
    let (_, plugin, runtime_id, view_id) = adapter(app, caller, target)?;
    running_plugin(app, &plugin, &runtime_id).await?;
    app.state::<AppState>()
        .plugins
        .render_bound_view(&plugin.id, &view_id, locale.as_deref(), &plugin)
        .await
}
pub(super) async fn run(
    app: &AppHandle,
    caller: (&str, &str),
    target: &super::Target,
    command: String,
    input: Value,
) -> AppResult<Value> {
    if !matches!(input, Value::Object(_)) {
        return Err(AppError::validation("plugin.input.invalid"));
    }
    let (_, plugin, runtime_id, _) = adapter(app, caller, target)?;
    let info = running_plugin(app, &plugin, &runtime_id).await?;
    if !info.commands.iter().any(|item| item.id == command) {
        return Err(AppError::validation("plugin.frontend.commandUnavailable"));
    }
    app.state::<AppState>()
        .plugins
        .run_bound(&plugin.id, &command, Some(input), &plugin)
        .await
}
pub(super) async fn snapshot(
    app: &AppHandle,
    caller: (&str, &str),
    target: &super::Target,
) -> AppResult<Value> {
    let (_, plugin, runtime_id, view_id) = adapter(app, caller, target)?;
    running_plugin(app, &plugin, &runtime_id).await?;
    Ok(json!({
        "pluginId": plugin.id,
        "generation": plugin.generation,
        "runtimeId": runtime_id,
        "viewId": view_id,
    }))
}
pub(super) async fn model(
    app: &AppHandle,
    caller: (&str, &str),
    target: &super::Target,
) -> AppResult<Value> {
    let (panel_id, plugin, runtime_id, _) = adapter(app, caller, target)?;
    running_plugin(app, &plugin, &runtime_id).await?;
    let registry = app.state::<native::Registry>();
    let ownership = native::lock(&registry);
    if !ownership.native_views.declarative.contains_key(&panel_id) {
        return Err(AppError::validation("plugin.frontend.expired"));
    }
    match target {
        super::Target::Owned { lease } => ownership
            .read_model(caller.0, caller.1, lease)
            .map_err(native::invalid),
        super::Target::Staged { id } => ownership
            .staged_model(caller.0, caller.1, id, Instant::now())
            .map_err(native::invalid),
    }
}

pub(super) fn close(app: &AppHandle, caller: (&str, &str), token: &str) -> AppResult<Value> {
    let registry = app.state::<native::Registry>();
    native::lock(&registry)
        .close_native_view(caller.0, caller.1, token)
        .map_err(native::invalid)?;
    Ok(Value::Null)
}

#[cfg(test)]
mod tests;
