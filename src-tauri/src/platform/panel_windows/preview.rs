//! Read-only presentation handles for host-owned preview tickets. A handle is
//! bound to one actual document and panel instance, never a plugin-bus payload.
use super::{
    native,
    ownership::{Lease, Ownership, MAIN},
    plugin_views::Target,
};
use serde::Deserialize;
use std::{collections::HashMap, time::Instant};
use tauri::{http, AppHandle, Manager};

type Result<T> = std::result::Result<T, &'static str>;
const MAX_HANDLES: usize = 32;

#[derive(Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Resource {
    id: String,
    ticket: String,
}
struct Publisher {
    document: String,
    resource: Resource,
    epoch: String,
}
struct Handle {
    window: String,
    document: String,
    target: Target,
    epoch: String,
}
#[derive(Default)]
pub(super) struct Resources {
    publisher: Option<Publisher>,
    handles: HashMap<String, Handle>,
}
impl Ownership {
    pub(super) fn publish_preview_resource(
        &mut self,
        window: &str,
        document: &str,
        resource: Option<Resource>,
    ) -> Result<bool> {
        self.main(window, document)?;
        if let Some(value) = &resource {
            if uuid::Uuid::parse_str(&value.id).is_err()
                || uuid::Uuid::parse_str(&value.ticket).is_err()
                || !self.panels.contains_key("filePreview")
            {
                return Err("preview.invalidTicket");
            }
        }
        if self
            .preview_resources
            .publisher
            .as_ref()
            .map(|p| (p.document.as_str(), &p.resource))
            == resource.as_ref().map(|r| (document, r))
        {
            return Ok(false);
        }
        // Host-generated epoch prevents an A->B->A publication from reviving
        // an old presentation even if a caller accidentally reuses an ID.
        self.preview_resources.publisher = resource.map(|resource| Publisher {
            document: document.into(),
            resource,
            epoch: uuid::Uuid::new_v4().to_string(),
        });
        self.preview_resources.handles.clear();
        Ok(true)
    }
    fn preview_target(
        &self,
        window: &str,
        document: &str,
        target: &Target,
        now: Instant,
    ) -> Result<()> {
        let panel = match target {
            Target::Owned { lease } => &self.owned(window, document, lease)?.lease.panel_id,
            Target::Staged { id } => &self.staged(window, document, id, now)?.offer.lease.panel_id,
        };
        if panel != "filePreview" {
            return Err("preview.invalidTicket");
        }
        Ok(())
    }
    pub(super) fn open_preview_handle(
        &mut self,
        window: &str,
        document: &str,
        target: Target,
        resource_id: &str,
        now: Instant,
    ) -> Result<String> {
        self.preview_target(window, document, &target, now)?;
        let source = self
            .preview_resources
            .publisher
            .as_ref()
            .ok_or("preview.invalidTicket")?;
        self.main(MAIN, &source.document)?;
        if source.resource.id != resource_id {
            return Err("preview.invalidTicket");
        }
        let epoch = source.epoch.clone();
        let expired: Vec<_> = self
            .preview_resources
            .handles
            .iter()
            .filter(|(id, handle)| {
                self.resolve_preview_handle(&handle.window, id, now)
                    .is_err()
            })
            .map(|(id, _)| id.clone())
            .collect();
        for id in expired {
            self.preview_resources.handles.remove(&id);
        }
        if self.preview_resources.handles.len() >= MAX_HANDLES {
            return Err("preview.busy");
        }
        let id = format!("panel-{}", uuid::Uuid::new_v4());
        self.preview_resources.handles.insert(
            id.clone(),
            Handle {
                window: window.into(),
                document: document.into(),
                target,
                epoch,
            },
        );
        Ok(id)
    }
    pub(super) fn resolve_preview_handle(
        &self,
        window: &str,
        id: &str,
        now: Instant,
    ) -> Result<String> {
        let handle = self
            .preview_resources
            .handles
            .get(id)
            .ok_or("preview.invalidTicket")?;
        if handle.window != window {
            return Err("preview.invalidTicket");
        }
        self.preview_target(window, &handle.document, &handle.target, now)?;
        let source = self
            .preview_resources
            .publisher
            .as_ref()
            .ok_or("preview.invalidTicket")?;
        self.main(MAIN, &source.document)?;
        if source.epoch != handle.epoch {
            return Err("preview.invalidTicket");
        }
        Ok(source.resource.ticket.clone())
    }
    pub(super) fn close_preview_handle(
        &mut self,
        window: &str,
        document: &str,
        id: &str,
    ) -> Result<()> {
        self.authorize(window, document)?;
        if let Some(handle) = self.preview_resources.handles.get(id) {
            if handle.window != window || handle.document != document {
                return Err("preview.invalidTicket");
            }
            self.preview_resources.handles.remove(id);
        }
        // Closing a display does not close the coordinator's underlying file.
        Ok(())
    }
    pub(super) fn promote_preview_handles(&mut self, id: &str, lease: &Lease, document: &str) {
        for handle in self.preview_resources.handles.values_mut() {
            if handle.window == lease.window_id
                && handle.document == document
                && matches!(&handle.target, Target::Staged { id: offer } if offer == id)
            {
                handle.target = Target::Owned {
                    lease: lease.clone(),
                };
            }
        }
    }
}

/// Satellite URLs contain an opaque presentation handle, never the main file
/// ticket. Recheck the SAME handle after asynchronous range I/O before delivery.
pub(crate) async fn serve_in_window(
    app: &AppHandle,
    window: &str,
    mut request: http::Request<Vec<u8>>,
    origin: String,
) -> http::Response<Vec<u8>> {
    let id = request
        .uri()
        .path()
        .strip_prefix('/')
        .unwrap_or("")
        .to_owned();
    let registry = app.state::<native::Registry>();
    if !id.starts_with("panel-") {
        return if window == MAIN {
            crate::preview::serve(&app.state::<crate::preview::Registry>(), request, origin).await
        } else {
            crate::preview::denied(&origin)
        };
    }
    let Ok(ticket) = native::lock(&registry).resolve_preview_handle(window, &id, Instant::now())
    else {
        return crate::preview::denied(&origin);
    };
    let mut parts = request.uri().clone().into_parts();
    parts.path_and_query = Some(format!("/{ticket}").parse().expect("UUID ticket path"));
    *request.uri_mut() = http::Uri::from_parts(parts).expect("preserved preview URI");
    let response = crate::preview::serve(
        &app.state::<crate::preview::Registry>(),
        request,
        origin.clone(),
    )
    .await;
    if native::lock(&registry)
        .resolve_preview_handle(window, &id, Instant::now())
        .as_ref()
        != Ok(&ticket)
    {
        return crate::preview::denied(&origin);
    }
    response
}

#[cfg(test)]
mod tests;
