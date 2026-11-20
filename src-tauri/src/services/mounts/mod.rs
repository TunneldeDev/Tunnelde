//! Host-owned persistent mount configuration shared by all implementations.
//! Native transports stay private; plugins use revisioned domain operations.
pub(crate) mod configuration;
pub mod contract;
pub(crate) mod legacy;
pub(crate) mod operations;
pub(crate) mod repository;
pub(crate) mod runtime;

#[cfg(test)]
mod tests;
