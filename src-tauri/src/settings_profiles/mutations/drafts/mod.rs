//! In-memory staging, owned by a runtime; no files or persistent authority.
mod registry;
pub(crate) use registry::{Claim, Registry};
use std::time::{Duration, Instant};

pub(super) const MAX_DRAFTS: usize = 4;
pub(super) const MAX_OWNER_DRAFTS: usize = 2;
pub(super) const MAX_RESERVED: usize = 32 * 1024 * 1024;
pub(crate) const MAX_APPEND_BYTES: usize = 32_768;
const IDLE: Duration = Duration::from_secs(120);
const LIFETIME: Duration = Duration::from_secs(600);

#[derive(Clone, PartialEq, Eq)]
pub(crate) struct Owner {
    pub id: String,
    pub fingerprint: String,
    pub generation: u64,
}
struct Entry {
    owner: Owner,
    revision: String,
    total: usize,
    created: Instant,
    touched: Instant,
    // None means claimed by a retained worker; its reservation stays charged.
    text: Option<String>,
}
impl Entry {
    fn expired(&self, now: Instant) -> bool {
        self.text.is_some()
            && (now.duration_since(self.touched) >= IDLE
                || now.duration_since(self.created) >= LIFETIME)
    }
}
fn missing() -> crate::error::AppError {
    crate::error::AppError::validation("profiles.draft.notFound")
}
