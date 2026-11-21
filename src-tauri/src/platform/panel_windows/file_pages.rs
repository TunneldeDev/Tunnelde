//! Host-private file-page resources. Prefixes/JS IDs are never capabilities.
//! Main binds existing user transports; the original document and source set
//! are rechecked at actual worker admission, remote dispatch and read delivery.
mod operations;
use super::{
    native,
    ownership::{Lease, Ownership, MAIN},
    plugin_views::Target,
};
use crate::{error::AppResult, ssh::session::SessionIdentity};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::HashMap, sync::Arc, time::Instant};
use tauri::{Manager, WebviewWindow};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum Source {
    Local {},
    Remote { session_id: String },
}
#[derive(Clone, PartialEq, Eq)]
struct Sources {
    local: bool,
    remote: HashMap<String, SessionIdentity>,
}
struct Binding {
    document: String,
    sources: Sources,
    allow_move: bool,
}
#[derive(Default)]
pub(super) struct Resources {
    bindings: HashMap<String, Arc<Binding>>,
}
#[derive(Deserialize)]
#[serde(
    tag = "operation",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum Operation {
    List {
        source: Source,
        path: Option<String>,
    },
    Home {
        source: Source,
    },
    Mkdir {
        source: Source,
        path: String,
    },
    CreateFile {
        source: Source,
        path: String,
    },
    Remove {
        source: Source,
        path: String,
        is_dir: bool,
    },
    Copy {
        source: Source,
        from: String,
        to: String,
        overwrite: bool,
    },
    Transfer {
        from_source: Source,
        from_path: String,
        to_source: Source,
        to_path: String,
        remove_source: bool,
        overwrite: bool,
    },
    Rename {
        source: Source,
        from: String,
        to: String,
        overwrite: bool,
    },
}
impl Operation {
    fn mutation(&self) -> bool {
        !matches!(self, Self::List { .. } | Self::Home { .. })
    }
    fn sources(&self) -> Vec<&Source> {
        match self {
            Self::List { source, .. }
            | Self::Home { source }
            | Self::Mkdir { source, .. }
            | Self::CreateFile { source, .. }
            | Self::Remove { source, .. }
            | Self::Rename { source, .. }
            | Self::Copy { source, .. } => vec![source],
            Self::Transfer {
                from_source,
                to_source,
                ..
            } => vec![from_source, to_source],
        }
    }
    fn valid(&self) -> bool {
        fn path(s: &str) -> bool {
            !s.is_empty() && s.len() <= 32768 && !s.contains('\0')
        }
        for source in self.sources() {
            if let Source::Remote { session_id } = source {
                if uuid::Uuid::parse_str(session_id).is_err() {
                    return false;
                }
            }
        }
        match self {
            Self::List { path: p, .. } => p.as_deref().is_none_or(path),
            Self::Home { .. } => true,
            Self::Mkdir { path: p, .. }
            | Self::CreateFile { path: p, .. }
            | Self::Remove { path: p, .. } => path(p),
            Self::Rename { from, to, .. } | Self::Copy { from, to, .. } => path(from) && path(to),
            Self::Transfer {
                from_path, to_path, ..
            } => path(from_path) && path(to_path),
        }
    }
}
#[derive(Deserialize)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum Request {
    Bind {
        panel_id: String,
        sources: Vec<Source>,
        allow_move: bool,
    },
    Unbind {
        panel_id: String,
    },
    Execute {
        target: Target,
        operation: Operation,
    },
}
fn valid_id(id: &str) -> bool {
    let uuid = |s: &str| uuid::Uuid::parse_str(s).is_ok();
    if let Some(id) = id.strip_prefix("files:") {
        return uuid(id);
    }
    let Some(id) = id.strip_prefix("sftp:") else {
        return false;
    };
    match id.split_once(":copy:") {
        Some((session, copy)) => uuid(session) && uuid(copy),
        None => uuid(id),
    }
}
impl Ownership {
    pub(super) fn retire_file_page(&mut self, id: &str) {
        self.file_pages.bindings.remove(id);
    }
    pub(super) fn file_page_registered(&self, id: &str) -> bool {
        self.file_pages
            .bindings
            .get(id)
            .is_some_and(|b| self.document(MAIN) == Some(b.document.as_str()))
    }
    pub(super) fn file_page_move_allowed(
        &self,
        id: &str,
        target: &str,
    ) -> Result<(), &'static str> {
        if target != MAIN
            && self
                .file_pages
                .bindings
                .get(id)
                .is_some_and(|b| !b.allow_move)
        {
            return Err("plugin.frontend.viewUnavailable");
        }
        Ok(())
    }
    pub(super) fn file_page_descriptors(&self) -> Vec<Value> {
        self.file_pages
            .bindings
            .iter()
            .filter(|(_, b)| self.document(MAIN) == Some(b.document.as_str()))
            .map(|(id, b)| json!({"panelId":id,"allowMove":b.allow_move}))
            .collect()
    }
    fn bind_file_page(
        &mut self,
        window: &str,
        document: &str,
        id: &str,
        sources: Sources,
        allow_move: bool,
    ) -> Result<Lease, &'static str> {
        self.main(window, document)?;
        if !valid_id(id)
            || (!sources.local && sources.remote.is_empty())
            || sources.remote.len() > 64
        {
            return Err("invalid file page");
        }
        if let Some(previous) = self.file_pages.bindings.get(id) {
            if previous.document == document
                && previous.sources == sources
                && previous.allow_move == allow_move
            {
                return self
                    .panels
                    .get(id)
                    .map(|p| p.lease.clone())
                    .ok_or("panel not found");
            }
            let panel = self.panels.get(id).ok_or("panel not found")?;
            if !panel.native_actions.is_empty() || self.file_page_transfer_pending(id) {
                return Err("panel interaction in progress");
            }
        } else if self.panels.contains_key(id) {
            return Err("unbound file page");
        }
        let lease = match self.panels.get(id) {
            Some(p) => p.lease.clone(),
            None => self.add_panel(window, document, id)?,
        };
        self.file_pages.bindings.insert(
            id.into(),
            Arc::new(Binding {
                document: document.into(),
                sources,
                allow_move,
            }),
        );
        Ok(lease)
    }
    fn file_page_target(
        &self,
        window: &str,
        document: &str,
        target: &Target,
        binding: &Arc<Binding>,
        mutation: bool,
    ) -> Result<Lease, &'static str> {
        let lease = match target {
            Target::Owned { lease } => {
                self.owned(window, document, lease)?;
                if mutation {
                    self.resource_action(window, document, lease)?;
                }
                lease.clone()
            }
            Target::Staged { id } if !mutation => {
                self.staged(window, document, id, Instant::now())?
                    .offer
                    .lease
            }
            _ => return Err("staged file page is read only"),
        };
        if self.document(MAIN) != Some(binding.document.as_str())
            || !self
                .file_pages
                .bindings
                .get(&lease.panel_id)
                .is_some_and(|b| Arc::ptr_eq(b, binding))
        {
            return Err("stale file page resource");
        }
        Ok(lease)
    }
    fn file_page_binding(
        &self,
        window: &str,
        document: &str,
        target: &Target,
    ) -> Result<Arc<Binding>, &'static str> {
        let id = match target {
            Target::Owned { lease } => lease.panel_id.clone(),
            Target::Staged { id } => {
                self.staged(window, document, id, Instant::now())?
                    .offer
                    .lease
                    .panel_id
            }
        };
        let binding = self
            .file_pages
            .bindings
            .get(&id)
            .cloned()
            .ok_or("unbound file page")?;
        self.file_page_target(window, document, target, &binding, false)?;
        Ok(binding)
    }
    fn begin_file_page_effect(
        &mut self,
        window: &str,
        document: &str,
        target: &Target,
        binding: &Arc<Binding>,
    ) -> Result<(Lease, String), &'static str> {
        let lease = self.file_page_target(window, document, target, binding, true)?;
        let panel = self.panels.get_mut(&lease.panel_id).unwrap();
        if panel.native_actions.len() >= 64 {
            return Err("sftp.transferBusy");
        }
        let id = uuid::Uuid::new_v4().to_string();
        panel.native_actions.insert(id.clone());
        Ok((lease, id))
    }
}

#[tauri::command]
pub(crate) async fn panel_window_files(
    window: WebviewWindow,
    document: String,
    request: Request,
) -> AppResult<Value> {
    let app = window.app_handle().clone();
    let caller = window.label().to_owned();
    let registry = app.state::<native::Registry>();
    match request {
        Request::Bind {
            panel_id,
            sources,
            allow_move,
        } => {
            native::lock(&registry)
                .main(&caller, &document)
                .map_err(native::invalid)?;
            let sources = operations::capture_sources(&app, sources)?;
            let lease = native::lock(&registry)
                .bind_file_page(&caller, &document, &panel_id, sources, allow_move)
                .map_err(native::invalid)?;
            native::changed(&app);
            Ok(json!(lease))
        }
        Request::Unbind { panel_id } => {
            let mut owner = native::lock(&registry);
            owner.main(&caller, &document).map_err(native::invalid)?;
            if !owner.file_pages.bindings.contains_key(&panel_id) {
                return Err(native::invalid("unbound file page"));
            }
            owner
                .remove_panel(&caller, &document, &panel_id)
                .map_err(native::invalid)?;
            drop(owner);
            native::changed(&app);
            Ok(Value::Null)
        }
        Request::Execute { target, operation } => {
            if !operation.valid() {
                return Err(native::invalid("plugin.tools.invalidPath"));
            }
            operations::execute(app.clone(), caller, document, target, operation).await
        }
    }
}
#[cfg(test)]
mod tests;
