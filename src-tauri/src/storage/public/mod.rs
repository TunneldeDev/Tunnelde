//! Public app-level storage contracts; no inventory scans or raw config exposure.
pub(crate) mod contracts;
mod projection;
mod service;
pub(crate) use service::{cancel, observe, prepare_schedule, schedule};
#[cfg(test)]
mod tests;
