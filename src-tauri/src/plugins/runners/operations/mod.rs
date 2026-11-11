//! User RPC operations; durable stop intent is independent of transport admission.
mod actions;
pub(in crate::plugins::runners) mod configuration;
mod launch;
pub(super) use actions::{action, stop_record};
pub(super) use launch::start;
