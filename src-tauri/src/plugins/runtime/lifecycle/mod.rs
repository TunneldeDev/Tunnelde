//! One lifecycle contract over domain-owned state; no second live-resource table.
mod adapters;
mod admission;
pub(in crate::plugins) mod contracts;
mod identity;
mod projection;
pub(in crate::plugins) mod rpc;

const MAX_ITEMS: usize = 4096;
const PAGE_SIZE: usize = 128;
const PAGE_BYTES: usize = 64 * 1024;
const OPERATIONS_PER_PLUGIN: usize = 4;
const OPERATIONS_TOTAL: usize = 16;
const OBSERVATION_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

#[cfg(test)]
#[path = "tests/discovery.rs"]
mod tests;
