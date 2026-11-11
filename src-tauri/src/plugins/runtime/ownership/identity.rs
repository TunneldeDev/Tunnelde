use crate::plugins::security::Lease;

pub(super) struct Entry<T> {
    pub(super) lease: Lease,
    pub(super) scope: Option<Scope>,
    pub(super) value: Option<T>,
    pub(super) accepted: bool,
}

/// Server-assigned request identity prevents reused public IDs from sharing ownership.
#[derive(Clone)]
pub(in crate::plugins) struct Scope {
    pub client: String,
    pub request: uuid::Uuid,
}

/// Private snapshot, never a caller-supplied resource token.
#[derive(Clone)]
pub(in crate::plugins) struct Ownership {
    pub(super) token: String,
    pub scope: Option<Scope>,
    pub accepted: bool,
}

impl Ownership {
    pub(in crate::plugins) fn identity(&self) -> &str {
        &self.token
    }
}
