//! Native OpenSSH config preview/import. Parsing is pure; filesystem reads are bounded.

mod contract;
mod parser;
mod service;

pub(crate) use contract::{ImportResult, Preview};
pub(crate) use service::{import, preview};
