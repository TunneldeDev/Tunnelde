//! A selected provider source is not an ordinary sidebar or activation token.
use super::*;
use std::sync::atomic::Ordering;

#[derive(Clone, PartialEq, Eq)]
pub(crate) struct ProviderSelection {
    revision: u64,
}
impl ProviderSelection {
    #[cfg(test)]
    pub(crate) fn test_selection(revision: u64) -> Self {
        Self { revision }
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
                .get("forwarding")
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
    tokio::time::timeout(std::time::Duration::from_secs(15), resolve(app))
        .await
        .map_err(|_| AppError::validation("plugin.timeout"))?
}
async fn resolve(app: &AppHandle) -> AppResult<Option<Source>> {
    let state = app.state::<AppState>();
    let (selection, provider) = {
        let settings = state.settings.read().unwrap_or_else(|e| e.into_inner());
        let Some(selection) = settings.ui_providers.get("forwarding").cloned() else {
            return Ok(None);
        };
        (
            selection,
            ProviderSelection {
                revision: state.ui_provider_revision.load(Ordering::SeqCst),
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
    fn selection_is_exact_and_an_aba_switch_never_revives_original_provider() {
        let mut settings = crate::settings::Settings::default();
        settings.ui_providers.insert(
            "forwarding".into(),
            serde_json::from_value(serde_json::json!({"pluginId":"selected","viewId":"forwards"}))
                .unwrap(),
        );
        let original = ProviderSelection { revision: 5 };
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
