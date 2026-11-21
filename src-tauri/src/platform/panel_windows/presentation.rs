//! Closed presentation metadata. No feature contents or view credentials.
use super::ownership::{Lease, Ownership, MAIN};
use serde::{Deserialize, Serialize};
type Result<T> = std::result::Result<T, &'static str>;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Presentation {
    Sidebar,
    Workspace,
    Floating,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Bounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct LayoutMetadata {
    presentation: Presentation,
    visible: bool,
    pinned: bool,
    bounds: Option<Bounds>,
    available: bool,
    presentations: Vec<Presentation>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PanelMetadata<'a> {
    id: &'a str,
    window_id: &'a str,
    #[serde(flatten)]
    metadata: &'a LayoutMetadata,
}
impl LayoutMetadata {
    pub(super) fn supports(&self, presentation: Presentation) -> bool {
        self.available && self.presentations.contains(&presentation)
    }
    pub(super) fn visible(&self) -> bool {
        self.visible
    }
    pub(super) fn presentation(&self) -> Presentation {
        self.presentation
    }
    pub(super) fn available(&self) -> bool {
        self.available
    }
    pub(super) fn validate(&self, window: &str) -> Result<()> {
        if self.presentations.is_empty()
            || self.presentations.len() > 3
            || !self.presentations.contains(&self.presentation)
            || self
                .presentations
                .iter()
                .enumerate()
                .any(|(i, p)| self.presentations[..i].contains(p))
            || (window != MAIN && self.presentations.contains(&Presentation::Sidebar))
            || (!self.available && self.visible)
            || self.bounds.as_ref().is_some_and(|b| {
                ![b.x, b.y, b.width, b.height].iter().all(|x| x.is_finite())
                    || b.x.abs() > 10_000_000.0
                    || b.y.abs() > 10_000_000.0
                    || b.width <= 0.0
                    || b.width > 1_000_000.0
                    || b.height <= 0.0
                    || b.height > 1_000_000.0
            })
        {
            return Err("invalid panel presentation");
        }
        Ok(())
    }
}
impl Ownership {
    pub(super) fn publish_presentation(
        &mut self,
        window: &str,
        document: &str,
        lease: &Lease,
        metadata: LayoutMetadata,
    ) -> Result<bool> {
        self.owned(window, document, lease)?;
        metadata.validate(window)?;
        let panel = self.panels.get_mut(&lease.panel_id).unwrap();
        let changed = panel.presentation.as_ref() != Some(&metadata);
        panel.presentation = Some(metadata);
        Ok(changed)
    }
    pub(super) fn publish_staged_presentation(
        &mut self,
        window: &str,
        document: &str,
        id: &str,
        metadata: LayoutMetadata,
        now: std::time::Instant,
    ) -> Result<bool> {
        self.authorize(window, document)?;
        metadata.validate(window)?;
        let pending = self.pending(id, now)?;
        if pending.target_window != window || pending.target_document != document {
            return Err("invalid staged destination");
        }
        let pending = self.transfers.get_mut(id).unwrap();
        let changed = pending.presentation.as_ref() != Some(&metadata);
        pending.presentation = Some(metadata);
        Ok(changed)
    }
    pub(super) fn publish_unavailable_preview(
        &mut self,
        window: &str,
        document: &str,
        metadata: LayoutMetadata,
    ) -> Result<bool> {
        self.main(window, document)?;
        metadata.validate(MAIN)?;
        if metadata.available {
            return Err("invalid unavailable preview");
        }
        let changed = self.preview_placeholder.as_ref() != Some(&metadata);
        self.preview_placeholder = Some(metadata);
        Ok(changed)
    }
    pub(super) fn panel_metadata(&self, lease: &Lease) -> Result<serde_json::Value> {
        let panel = self
            .panels
            .get(&lease.panel_id)
            .filter(|p| p.lease == *lease)
            .ok_or("stale panel owner")?;
        let metadata = panel
            .presentation
            .as_ref()
            .ok_or("panel.window.viewNotReady")?;
        Ok(serde_json::to_value(PanelMetadata {
            id: &lease.panel_id,
            window_id: &lease.window_id,
            metadata,
        })
        .unwrap())
    }
    pub(super) fn presentation_projection(&self) -> Option<serde_json::Value> {
        let mut rows = Vec::new();
        for lease in self.leases() {
            rows.push(self.panel_metadata(&lease).ok()?);
        }
        if !self.panels.contains_key("filePreview") {
            rows.push(
                serde_json::to_value(PanelMetadata {
                    id: "filePreview",
                    window_id: MAIN,
                    metadata: self.preview_placeholder.as_ref()?,
                })
                .unwrap(),
            );
        }
        rows.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
        Some(serde_json::json!({"windowId": MAIN, "panels": rows}))
    }
}

#[cfg(test)]
mod tests;
