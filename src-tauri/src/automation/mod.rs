//! Versioned local automation boundary. No direct webview command forwarding.
pub mod cli;
mod client;
mod contract;
mod domains;
pub(crate) mod transport;

#[cfg(test)]
mod tests;
