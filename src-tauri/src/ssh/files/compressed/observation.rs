//! Observe original wire replies independently of delivery to cancelled callers.
use super::*;
use crate::ssh::files::native_save::runtime::{MutationObservation, MutationReceipt};

pub(super) struct Observer {
    requests: MutationObservation,
    handles: Mutex<HashMap<String, MutationReceipt>>,
}

pub(super) struct Pending {
    receipt: Option<MutationReceipt>,
    kind: Kind,
}

enum Kind {
    Read,
    Open,
    Close(MutationReceipt),
    Mutation,
}

impl Observer {
    pub(super) fn new(requests: MutationObservation) -> Self {
        Self {
            requests,
            handles: Mutex::new(HashMap::new()),
        }
    }

    /// Called after serialization and queue cancellation checks, immediately
    /// before the first possible write. Queued but unsent work owns no receipt.
    pub(super) fn begin(&self, header: &Value) -> AppResult<Pending> {
        let kind = match header["op"].as_str() {
            Some("open") if header["write"] == true => Kind::Open,
            Some("write" | "archive_write" | "mkdir_private") => Kind::Mutation,
            Some("close") => {
                let handle = header["handle"].as_str().unwrap_or_default();
                if let Some(open) = self.handles.lock().unwrap().remove(handle) {
                    // Carry the exact OPEN receipt through the original CLOSE.
                    // Never resolve it by a possibly reused handle after await.
                    Kind::Close(open)
                } else {
                    Kind::Read
                }
            }
            _ => Kind::Read,
        };
        let receipt = if matches!(kind, Kind::Read) {
            None
        } else {
            Some(
                self.requests
                    .begin()
                    .ok_or_else(|| AppError::validation("editor.remoteOutcomeUnknown"))?,
            )
        };
        Ok(Pending { receipt, kind })
    }

    pub(super) fn complete(&self, pending: Pending, reply: &Reply) -> AppResult<()> {
        let Some(receipt) = pending.receipt else {
            return Ok(());
        };
        // A matching id alone does not prove completion. Accept only the shape
        // emitted by this protocol for the original mutation or terminal error.
        if reply.size != 0 || reply.length.is_some() || reply.compressed {
            return Err(protocol_error());
        }
        if let Some(error) = &reply.error {
            if reply.handle.is_some() || error.chars().count() > 512 {
                return Err(protocol_error());
            }
            receipt.acknowledge();
            // Failed CLOSE is not proof that the writable handle was closed.
            return Ok(());
        }
        match pending.kind {
            Kind::Open => {
                let handle = reply
                    .handle
                    .as_ref()
                    .filter(|h| !h.is_empty() && h.len() <= 128)
                    .ok_or_else(protocol_error)?;
                let mut handles = self.handles.lock().unwrap();
                if handles.contains_key(handle) {
                    return Err(protocol_error());
                }
                // The OPEN receipt becomes the live handle's receipt. Even a
                // caller that never receives this handle cannot lose its owner.
                handles.insert(handle.clone(), receipt);
            }
            Kind::Close(open) => {
                if reply.handle.is_some() {
                    return Err(protocol_error());
                }
                open.acknowledge();
                receipt.acknowledge();
            }
            Kind::Mutation => {
                if reply.handle.is_some() {
                    return Err(protocol_error());
                }
                receipt.acknowledge();
            }
            Kind::Read => unreachable!(),
        }
        Ok(())
    }
}
