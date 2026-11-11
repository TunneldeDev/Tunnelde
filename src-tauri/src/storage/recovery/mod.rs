//! Public metadata and deferred recovery requests; never run bulk I/O here.
pub(crate) mod contracts;
mod projection;
mod service;
pub(crate) use service::{observe, request};
#[cfg(test)]
mod tests;
