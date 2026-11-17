//! Shared file services. Source authority remains with each native/plugin caller.
pub(crate) mod admission;
pub(crate) mod local;
pub(crate) mod operations;
pub mod read;
pub mod text_encoding;
pub(crate) mod write;
