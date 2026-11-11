//! Plugin-owned declarative settings. Transport identity and authorization stay outside.
pub mod contracts;
mod migration;
pub mod repository;
mod schema;
pub mod service;

pub const MAX_DOCUMENT: usize = 64 * 1024;
pub const MAX_BACKUPS: usize = 8;

#[cfg(test)]
mod tests;
