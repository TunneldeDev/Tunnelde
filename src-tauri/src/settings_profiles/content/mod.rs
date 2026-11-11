//! Revision-bound public profile contents. Native persistence remains authoritative.
mod cache;
pub(crate) mod contracts;
mod projection;
mod read;

pub(crate) use read::{catalogue, read};

pub(crate) const MAX_CONTENT_BYTES: usize = super::observation::MAX_STORAGE_BYTES + 65_536;
pub(crate) const MAX_CHUNK_BYTES: usize = 65_536;
const MAX_RESPONSE_BYTES: usize = 131_072;

#[cfg(test)]
mod tests;
