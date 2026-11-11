//! Domain adapters call shared application services; no global RPC business logic.
pub(super) mod application;
pub(super) mod clipboard;
pub(super) mod connections;
pub(super) mod files;
pub(super) mod forwarding;
pub(super) mod history;
pub(super) mod hosts;
pub(super) mod logging;
pub(super) mod monitor;
pub(super) mod settings;
pub(super) mod storage;
pub(super) mod terminal;
pub(super) mod workbench;
