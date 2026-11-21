//! A selected provider source is not an ordinary sidebar or activation token.
use super::*;
use std::sync::atomic::Ordering;

#[derive(Clone, PartialEq, Eq)]
pub(crate) struct ProviderSelection {
    revision: u64,
    target: &'static str,
}
impl ProviderSelection {
    #[cfg(test)]
    pub(crate) fn test_selection(revision: u64) -> Self {
        Self {
            revision,
            target: "forwarding",
        }
    }
    #[cfg(test)]
    pub(crate) fn test_tasks_selection(revision: u64) -> Self {
        Self {
            revision,
            target: "backgroundTasks",
        }
    }
    #[cfg(test)]
    pub(crate) fn test_preview_selection(revision: u64) -> Self {
        Self {
            revision,
            target: "filePreview",
        }
    }
    #[cfg(test)]
    pub(crate) fn test_hosts_selection(revision: u64) -> Self {
        Self {
            revision,
            target: "hostList",
        }
    }
    #[cfg(test)]
    pub(crate) fn test_preferences_selection(revision: u64) -> Self {
        Self {
            revision,
            target: "preferences",
        }
    }
    pub(crate) fn target(&self) -> &'static str {
        self.target
    }
    pub(crate) fn permissions(&self) -> &'static [&'static str] {
        match self.target {
            "hostList" => &["ui.trusted", "hosts.read"],
            "preferences" => &["ui.trusted", "settings.read"],
            "filePreview" => &["ui.trusted", "filePreview.read"],
            "backgroundTasks" => &["ui.trusted", "backgroundTasks.read"],
            _ => &["ui.trusted", "hosts.read", "forwards.read"],
        }
    }
    pub(crate) fn revision(&self) -> u64 {
        self.revision
    }
    pub(super) fn check(
        &self,
        settings: &crate::settings::Settings,
        revision: u64,
        plugin: &str,
        view: &str,
    ) -> AppResult<()> {
        if revision != self.revision
            || !settings
                .ui_providers
                .get(self.target)
                .is_some_and(|selected| selected.plugin_id == plugin && selected.view_id == view)
        {
            return Err(AppError::validation("plugin.forwarding.expired"));
        }
        Ok(())
    }
}
/// Only authoritative host selection chooses a provider. Never start a plugin,
/// ensure a singleton or trust caller-supplied package/runtime metadata here.
pub(crate) async fn selected_forwarding_source(app: &AppHandle) -> AppResult<Option<Source>> {
    tokio::time::timeout(
        std::time::Duration::from_secs(15),
        resolve(app, "forwarding"),
    )
    .await
    .map_err(|_| AppError::validation("plugin.timeout"))?
}
pub(crate) async fn selected_tasks_source(app: &AppHandle) -> AppResult<Option<Source>> {
    tokio::time::timeout(
        std::time::Duration::from_secs(15),
        resolve(app, "backgroundTasks"),
    )
    .await
    .map_err(|_| AppError::validation("plugin.timeout"))?
}
pub(crate) async fn selected_preview_source(app: &AppHandle) -> AppResult<Option<Source>> {
    tokio::time::timeout(
        std::time::Duration::from_secs(15),
        resolve(app, "filePreview"),
    )
    .await
    .map_err(|_| AppError::validation("plugin.timeout"))?
}
pub(crate) async fn selected_hosts_source(app: &AppHandle) -> AppResult<Option<Source>> {
    tokio::time::timeout(std::time::Duration::from_secs(15), resolve(app, "hostList"))
        .await
        .map_err(|_| AppError::validation("plugin.timeout"))?
}
pub(crate) async fn selected_preferences_source(app: &AppHandle) -> AppResult<Option<Source>> {
    tokio::time::timeout(
        std::time::Duration::from_secs(15),
        resolve(app, "preferences"),
    )
    .await
    .map_err(|_| AppError::validation("plugin.timeout"))?
}
async fn resolve(app: &AppHandle, target: &'static str) -> AppResult<Option<Source>> {
    let state = app.state::<AppState>();
    let (selection, provider) = {
        let settings = state.settings.read().unwrap_or_else(|e| e.into_inner());
        let Some(selection) = settings.ui_providers.get(target).cloned() else {
            return Ok(None);
        };
        (
            selection,
            ProviderSelection {
                revision: state.ui_provider_revision.load(Ordering::SeqCst),
                target,
            },
        )
    };
    let runtime = state
        .plugins
        .list()
        .await
        .into_iter()
        .find(|plugin| plugin.id == selection.plugin_id && plugin.status == PluginStatus::Running)
        .and_then(|plugin| plugin.runtime_id)
        .ok_or_else(|| AppError::validation("plugin.notRunning"))?;
    let source = source_for(
        app,
        &selection.plugin_id,
        &runtime,
        &selection.view_id,
        Some(provider),
    )
    .await?;
    source.with_current(app, || Ok(()))?;
    Ok(Some(source))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn task_provider_requires_its_own_selection_revision_and_minimum_read_permission() {
        let mut settings = crate::settings::Settings::default();
        let tasks = ProviderSelection::test_tasks_selection(3);
        assert_eq!(tasks.permissions(), &["ui.trusted", "backgroundTasks.read"]);
        settings.ui_providers.insert(
            "forwarding".into(),
            serde_json::from_value(serde_json::json!({"pluginId":"p","viewId":"tasks"})).unwrap(),
        );
        assert!(tasks.check(&settings, 3, "p", "tasks").is_err());
        settings.ui_providers.insert(
            "backgroundTasks".into(),
            settings.ui_providers["forwarding"].clone(),
        );
        assert!(tasks.check(&settings, 3, "p", "tasks").is_ok());
        for (revision, plugin, view) in [(4, "p", "tasks"), (3, "q", "tasks"), (3, "p", "other")] {
            assert!(tasks.check(&settings, revision, plugin, view).is_err());
        }
        settings.ui_providers.remove("backgroundTasks");
        assert!(tasks.check(&settings, 3, "p", "tasks").is_err());
    }
    #[test]
    fn selection_is_exact_and_an_aba_switch_never_revives_original_provider() {
        let mut settings = crate::settings::Settings::default();
        settings.ui_providers.insert(
            "forwarding".into(),
            serde_json::from_value(serde_json::json!({"pluginId":"selected","viewId":"forwards"}))
                .unwrap(),
        );
        let original = ProviderSelection {
            revision: 5,
            target: "forwarding",
        };
        assert!(original.check(&settings, 5, "selected", "forwards").is_ok());
        for (revision, plugin, view) in [
            (6, "selected", "forwards"),
            (7, "selected", "forwards"),
            (5, "foreign", "forwards"),
            (5, "selected", "other"),
        ] {
            assert!(original.check(&settings, revision, plugin, view).is_err());
        }
        settings.ui_providers.remove("forwarding");
        assert!(original
            .check(&settings, 5, "selected", "forwards")
            .is_err());
    }
}

#[cfg(test)]
mod preview_tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn preview_selection_uses_its_own_read_grant_and_revision() {
        let selected = ProviderSelection::test_preview_selection(4);
        assert_eq!(selected.permissions(), &["ui.trusted", "filePreview.read"]);
        let mut settings = crate::settings::Settings::default();
        let value =
            serde_json::from_value(json!({"pluginId":"preview-ui", "viewId":"preview"})).unwrap();
        settings
            .ui_providers
            .insert("backgroundTasks".into(), value);
        assert!(selected
            .check(&settings, 4, "preview-ui", "preview")
            .is_err());
        settings.ui_providers.insert(
            "filePreview".into(),
            settings.ui_providers["backgroundTasks"].clone(),
        );
        assert!(selected
            .check(&settings, 4, "preview-ui", "preview")
            .is_ok());
        assert!(selected
            .check(&settings, 5, "preview-ui", "preview")
            .is_err());
        assert!(selected
            .check(&settings, 6, "preview-ui", "preview")
            .is_err());
    }
}
