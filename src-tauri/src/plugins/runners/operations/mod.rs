//! User RPC operations; durable stop intent is independent of transport admission.
mod actions;
mod launch;
pub(super) use actions::{action, stop_record};
pub(super) use launch::start;
