//! Opt-in restart recovery, distinct from native save-operation recovery.
pub(crate) mod commands;
mod contracts;
mod repository;

pub(crate) use repository::clear;

#[cfg(test)]
mod tests;
