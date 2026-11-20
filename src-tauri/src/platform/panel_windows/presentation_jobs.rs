//! Source-document UI effects. Begin is the admission point; cancellation after
//! admission cannot revoke a synchronous presentation change already accepted.
use super::{
    ownership::{Lease, Ownership},
    presentation::{LayoutMetadata, Presentation},
};
use crate::plugins::{security::Lease as PluginLease, InvocationFence};
use serde::Serialize;
use serde_json::Value;
use std::time::{Duration, Instant};
use tokio::sync::oneshot;
type Result<T> = std::result::Result<T, &'static str>;
const TTL: Duration = Duration::from_secs(15);
#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum PresentationOperation {
    Set { presentation: Presentation },
    Close,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PresentationJob {
    id: String,
    lease: Lease,
    operation: PresentationOperation,
}
pub(super) struct PendingPresentation {
    lease: Lease,
    document: String,
    owner: PluginLease,
    invocation: Option<InvocationFence>,
    operation: PresentationOperation,
    claimed: bool,
    started: bool,
    deadline: Instant,
    reply: oneshot::Sender<Result<Value>>,
}
impl Ownership {
    pub(super) fn submit_presentation(
        &mut self,
        owner: PluginLease,
        panel_id: &str,
        operation: PresentationOperation,
        now: Instant,
    ) -> Result<(String, oneshot::Receiver<Result<Value>>)> {
        self.expire(now);
        let lease = self
            .leases()
            .into_iter()
            .find(|p| p.panel_id == panel_id)
            .ok_or("panel.unavailable")?;
        let document = self
            .document(&lease.window_id)
            .ok_or("source unavailable")?
            .to_owned();
        self.action(&lease.window_id, &document, &lease)?;
        let panel = self.owned(&lease.window_id, &document, &lease)?;
        let metadata = panel
            .presentation
            .as_ref()
            .ok_or("panel.window.viewNotReady")?;
        if !metadata.available() {
            return Err("panel.unavailable");
        }
        if let PresentationOperation::Set { presentation } = &operation {
            if !metadata.supports(*presentation) {
                return Err("panel.window.unsupportedPresentation");
            }
        }
        // This also rejects consent and unrelated native effects. The reserved
        // ID is exchanged only for this source's admitted UI effect.
        if !panel.native_actions.is_empty() {
            return Err("panel interaction in progress");
        }
        if self.presentation_jobs.len() >= 32
            || self
                .presentation_jobs
                .values()
                .filter(|j| j.owner.id == owner.id)
                .count()
                >= 8
        {
            return Err("panel presentation limit");
        }
        let id = uuid::Uuid::new_v4().to_string();
        self.relay_fence(panel_id, &id, true)?;
        self.authorize_move_fence(&lease.window_id, &document, &lease, &id)
            .inspect_err(|_| {
                let _ = self.relay_fence(panel_id, &id, false);
            })?;
        let (reply, receiver) = oneshot::channel();
        self.presentation_jobs.insert(
            id.clone(),
            PendingPresentation {
                lease,
                document,
                owner,
                invocation: crate::plugins::current_invocation_fence(),
                operation,
                claimed: false,
                started: false,
                deadline: now + TTL,
                reply,
            },
        );
        Ok((id, receiver))
    }
    fn presentation_source_document(
        &self,
        window: &str,
        document: &str,
        id: &str,
    ) -> Result<&PendingPresentation> {
        self.authorize(window, document)?;
        let job = self
            .presentation_jobs
            .get(id)
            .ok_or("panel presentation expired")?;
        if job.lease.window_id != window || job.document != document {
            return Err("invalid presentation source");
        }
        Ok(job)
    }
    fn presentation_source(
        &self,
        window: &str,
        document: &str,
        id: &str,
    ) -> Result<&PendingPresentation> {
        let job = self.presentation_source_document(window, document, id)?;
        self.owned(window, document, &job.lease)?;
        Ok(job)
    }
    pub(super) fn claim_presentations(
        &mut self,
        window: &str,
        document: &str,
        now: Instant,
    ) -> Result<Vec<PresentationJob>> {
        self.authorize(window, document)?;
        self.expire_presentation_jobs(now);
        let mut jobs = Vec::new();
        for (id, job) in &mut self.presentation_jobs {
            if job.lease.window_id == window && job.document == document && !job.claimed {
                job.claimed = true;
                jobs.push(PresentationJob {
                    id: id.clone(),
                    lease: job.lease.clone(),
                    operation: job.operation.clone(),
                });
            }
        }
        Ok(jobs)
    }
    pub(super) fn require_presentation_source(
        &self,
        window: &str,
        document: &str,
        id: &str,
    ) -> Result<()> {
        self.presentation_source(window, document, id).map(|_| ())
    }
    pub(super) fn presentation_admission(
        &mut self,
        window: &str,
        document: &str,
        id: &str,
        now: Instant,
    ) -> Result<(PluginLease, Option<InvocationFence>)> {
        self.expire_presentation_jobs(now);
        let job = self.presentation_source(window, document, id)?;
        if !job.claimed || job.started {
            return Err("invalid presentation phase");
        }
        self.action(window, document, &job.lease)?;
        let metadata = self
            .owned(window, document, &job.lease)?
            .presentation
            .as_ref()
            .ok_or("panel.window.viewNotReady")?;
        if !metadata.available() {
            return Err("panel.unavailable");
        }
        if let PresentationOperation::Set { presentation } = job.operation {
            if !metadata.supports(presentation) {
                return Err("panel.window.unsupportedPresentation");
            }
        }
        self.authorize_move_fence(window, document, &job.lease, id)?;
        Ok((job.owner.clone(), job.invocation.clone()))
    }
    pub(super) fn admit_presentation(&mut self, id: &str) {
        self.presentation_jobs.get_mut(id).unwrap().started = true;
    }
    pub(super) fn complete_presentation(
        &mut self,
        window: &str,
        document: &str,
        id: &str,
        metadata: LayoutMetadata,
    ) -> Result<()> {
        let job = self.presentation_source(window, document, id)?;
        if !job.started {
            return Err("invalid presentation phase");
        }
        let matches = match job.operation {
            PresentationOperation::Close => !metadata.visible(),
            PresentationOperation::Set { presentation } => {
                metadata.available()
                    && metadata.visible()
                    && metadata.presentation() == presentation
            }
        };
        if !matches {
            return Err("invalid presentation result");
        }
        let lease = job.lease.clone();
        let close = matches!(job.operation, PresentationOperation::Close);
        self.publish_presentation(window, document, &lease, metadata)?;
        let result = if close {
            Value::Null
        } else {
            self.panel_metadata(&lease)?
        };
        self.finish_presentation(id, Ok(result));
        Ok(())
    }
    pub(super) fn fail_presentation(
        &mut self,
        window: &str,
        document: &str,
        id: &str,
    ) -> Result<()> {
        // Cleanup of this exact document's admitted effect remains possible
        // after a retired factory advances the panel generation. It cannot
        // publish metadata or operate on the replacement lease.
        self.presentation_source_document(window, document, id)?;
        self.finish_presentation(id, Err("panel.window.sourceUnavailable"));
        Ok(())
    }
    fn finish_presentation(&mut self, id: &str, result: Result<Value>) {
        if let Some(job) = self.presentation_jobs.remove(id) {
            let _ = self.relay_fence(&job.lease.panel_id, id, false);
            let _ = job.reply.send(result);
        }
    }
    pub(super) fn cancel_presentation(&mut self, id: &str) -> bool {
        if self.presentation_jobs.get(id).is_none_or(|j| j.started) {
            return false;
        }
        self.finish_presentation(id, Err("panel.window.cancelled"));
        true
    }
    pub(super) fn expire_presentation_jobs(&mut self, now: Instant) {
        // An admitted IPC reply can still be in flight. Never free that fence
        // on caller cancellation, permission retirement or a queue TTL. Only
        // source completion or exact-document loss settles the accepted effect.
        let ids: Vec<_> = self
            .presentation_jobs
            .iter()
            .filter(|(_, j)| !j.started && (j.deadline <= now || j.reply.is_closed()))
            .map(|(id, _)| id.clone())
            .collect();
        for id in ids {
            self.cancel_presentation(&id);
        }
    }
    pub(super) fn retire_presentation_document(&mut self, window: &str) {
        let ids: Vec<_> = self
            .presentation_jobs
            .iter()
            .filter(|(_, j)| j.lease.window_id == window)
            .map(|(id, _)| id.clone())
            .collect();
        for id in ids {
            self.finish_presentation(&id, Err("stale window document"));
        }
    }
    pub(super) fn remove_presentation_panel(&mut self, panel: &str) -> Result<()> {
        if self
            .presentation_jobs
            .values()
            .any(|j| j.lease.panel_id == panel && j.started)
        {
            return Err("panel interaction in progress");
        }
        let ids: Vec<_> = self
            .presentation_jobs
            .iter()
            .filter(|(_, j)| j.lease.panel_id == panel)
            .map(|(id, _)| id.clone())
            .collect();
        for id in ids {
            self.cancel_presentation(&id);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests;
