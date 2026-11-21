//! Explicit main-document factory admission. A `plugin:` prefix is not an
//! adapter, and metadata is never an activation/module/resource capability.
use super::Ownership;
use crate::plugins::frontend::native::{Source, ViewDescriptor};
use serde::Serialize;

#[derive(Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Descriptor {
    pub(crate) panel_id: String,
    pub(crate) revision: String,
    #[serde(flatten)]
    pub(crate) view: ViewDescriptor,
}
pub(super) struct Adapter {
    pub(super) source: Source,
    descriptor: Descriptor,
}
impl Ownership {
    pub(in crate::platform::panel_windows) fn transferable(&self, panel_id: &str) -> bool {
        super::super::ownership::transferable(panel_id)
            || self.terminal_registered(panel_id)
            || self.file_page_registered(panel_id)
            || self.editor_page_registered(panel_id)
            || self.host_page_registered(panel_id)
            || self.settings_page_registered(panel_id)
            || self.native_views.adapters.contains_key(panel_id)
    }
    pub(in crate::platform::panel_windows) fn plugin_adapters(&self) -> Vec<Descriptor> {
        let mut list: Vec<_> = self
            .native_views
            .adapters
            .values()
            .map(|adapter| adapter.descriptor.clone())
            .collect();
        list.sort_by(|a, b| a.panel_id.cmp(&b.panel_id));
        list
    }
    /// Only the coordinator, after it has loaded the module and selected the
    /// factory path, may opt in an ordinary sidebar. Native source review still
    /// verifies the live runtime, contribution and allowFloating declaration.
    pub(super) fn register_plugin_adapter(
        &mut self,
        window: &str,
        document: &str,
        source: Source,
    ) -> Result<(Descriptor, bool), &'static str> {
        self.main(window, document)?;
        let view = source.descriptor();
        let panel_id = format!("plugin:{}:{}", view.plugin_id, view.view_id);
        if !view.allow_floating || !self.panels.contains_key(&panel_id) {
            return Err("plugin.frontend.undeclaredContribution");
        }
        if let Some(current) = self.native_views.adapters.get(&panel_id) {
            if !current.source.same_module(&source) {
                // Never give a new runtime the previous factory's capsule. Its
                // retirement must first invalidate the old approval and state.
                return Err("plugin.frontend.adapterChanged");
            }
            return Ok((current.descriptor.clone(), false));
        }
        // Retirement is not rollback. A new renderer must not overtake a
        // prior module's accepted native/UI effect, even in the same runtime.
        if !self.panels[&panel_id].native_actions.is_empty() {
            return Err("panel interaction in progress");
        }
        let descriptor = Descriptor {
            panel_id: panel_id.clone(),
            revision: uuid::Uuid::new_v4().to_string(),
            view,
        };
        self.native_views.adapters.insert(
            panel_id,
            Adapter {
                source,
                descriptor: descriptor.clone(),
            },
        );
        Ok((descriptor, true))
    }
    pub(super) fn admit_plugin_adapter_open(&self, source: &Source) -> Result<(), &'static str> {
        let view = source.descriptor();
        let panel_id = format!("plugin:{}:{}", view.plugin_id, view.view_id);
        if self
            .native_views
            .adapters
            .get(&panel_id)
            .is_some_and(|adapter| !adapter.source.same_module(source))
        {
            return Err("plugin.frontend.adapterChanged");
        }
        Ok(())
    }
    pub(super) fn unregister_plugin_adapter(
        &mut self,
        window: &str,
        document: &str,
        panel_id: &str,
        runtime: &str,
        generation: u64,
        revision: &str,
    ) -> Result<bool, &'static str> {
        self.main(window, document)?;
        let Some(adapter) = self.native_views.adapters.get(panel_id) else {
            return Ok(false);
        };
        if adapter.descriptor.view.runtime_id != runtime
            || adapter.source.lease.generation != generation
            || adapter.descriptor.revision != revision
        {
            return Err("plugin.frontend.adapterChanged");
        }
        self.native_views.adapters.remove(panel_id);
        self.reset_plugin_panel(panel_id);
        Ok(true)
    }
    pub(super) fn retire_plugin_adapters(&mut self, retired: impl Fn(&Source) -> bool) -> bool {
        let ids: Vec<_> = self
            .native_views
            .adapters
            .iter()
            .filter(|(_, adapter)| retired(&adapter.source))
            .map(|(id, _)| id.clone())
            .collect();
        for id in &ids {
            self.native_views.adapters.remove(id);
            self.reset_plugin_panel(id);
        }
        !ids.is_empty()
    }
    pub(in crate::platform::panel_windows) fn begin_plugin_model(
        &mut self,
        window: &str,
        document: &str,
        panel_id: &str,
        revision: &str,
    ) -> Result<String, &'static str> {
        self.main(window, document)?;
        if !self
            .native_views
            .adapters
            .get(panel_id)
            .is_some_and(|a| a.descriptor.revision == revision)
        {
            return Err("plugin.frontend.adapterChanged");
        }
        self.begin_model(window, document, panel_id)
    }
    pub(in crate::platform::panel_windows) fn remove_plugin_adapter(&mut self, panel_id: &str) {
        self.native_views.adapters.remove(panel_id);
    }
}

#[cfg(test)]
mod tests;
