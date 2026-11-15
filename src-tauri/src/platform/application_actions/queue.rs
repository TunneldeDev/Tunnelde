use super::Action;
use crate::error::{AppError, AppResult};
use serde::Serialize;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Request {
    pub id: String,
    pub action: Action,
    pub owner: String,
}

struct Pending {
    id: String,
    action: Action,
    delivered_to: Option<String>,
    committing: bool,
}

/// One bounded native intent. A document may finish only the request delivered
/// to it; a new menu selection invalidates the preceding confirmation.
#[derive(Default)]
pub(super) struct Queue {
    owner: Option<String>,
    pending: Option<Pending>,
}

impl Queue {
    pub fn submit(&mut self, action: Action) {
        if self.pending.as_ref().is_some_and(|p| p.committing) {
            return;
        }
        self.pending = Some(Pending {
            id: uuid::Uuid::new_v4().to_string(),
            action,
            delivered_to: None,
            committing: false,
        });
    }

    pub fn claim(&mut self, owner: String) {
        if self.owner.as_deref() != Some(&owner) {
            self.reset();
            self.owner = Some(owner);
        }
    }

    pub fn release(&mut self, owner: &str) {
        if self.owner.as_deref() == Some(owner) {
            self.reset();
        }
    }

    pub fn reset(&mut self) {
        self.owner = None;
        // An unread intent survives window creation. A cancelled or abandoned
        // dialog is never replayed into a new document.
        if self
            .pending
            .as_ref()
            .is_some_and(|p| p.delivered_to.is_some())
        {
            self.pending = None;
        }
    }

    pub fn take_delivery(&mut self) -> Option<Request> {
        let owner = self.owner.as_ref()?;
        let pending = self.pending.as_mut()?;
        if pending.committing || pending.delivered_to.is_some() {
            return None;
        }
        pending.delivered_to = Some(owner.clone());
        Some(Request {
            id: pending.id.clone(),
            action: pending.action,
            owner: owner.clone(),
        })
    }

    pub fn delivery_failed(&mut self, request: &Request) {
        if let Some(pending) = &mut self.pending {
            if pending.id == request.id && !pending.committing {
                pending.delivered_to = None;
            }
        }
    }

    pub fn begin(&mut self, owner: &str, id: &str) -> AppResult<Action> {
        let pending = self.pending.as_mut().filter(|pending| {
            self.owner.as_deref() == Some(owner)
                && pending.id == id
                && pending.delivered_to.as_deref() == Some(owner)
                && !pending.committing
        });
        let pending = pending.ok_or_else(|| AppError::validation("restart.requestChanged"))?;
        pending.committing = true;
        Ok(pending.action)
    }

    pub fn failed(&mut self, id: &str) {
        if let Some(pending) = &mut self.pending {
            if pending.id == id {
                pending.committing = false;
            }
        }
    }
}
