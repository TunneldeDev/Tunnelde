//! Domain-owned plugin method discovery. Transport and services live outside this catalogue.

use serde::Serialize;
use std::sync::LazyLock;

#[derive(Clone, Copy, Serialize)]
pub struct ApiMethod {
    pub name: &'static str,
    pub permissions: &'static [&'static str],
    pub params: &'static str,
    pub description: &'static str,
    /// Compatibility state for this method. New methods start experimental;
    /// promotion to stable is an explicit contract decision.
    pub stability: &'static str,
    pub since: Option<&'static str>,
    pub deprecated: Option<&'static str>,
}

macro_rules! method {
    ($name:literal, [$($permission:literal),*], $params:literal, $description:literal) => {
        ApiMethod {
            name: $name,
            permissions: &[$($permission),*],
            params: $params,
            description: $description,
            stability: "experimental",
            since: None,
            deprecated: None,
        }
    };
}

macro_rules! stable_method {
    ($name:literal, [$($permission:literal),*], $params:literal, $description:literal, $since:literal) => {
        ApiMethod {
            name: $name,
            permissions: &[$($permission),*],
            params: $params,
            description: $description,
            stability: "stable",
            since: Some($since),
            deprecated: None,
        }
    };
}

#[path = "application/methods.rs"]
mod application;
#[path = "clipboard/methods.rs"]
mod clipboard;
#[path = "configuration/methods.rs"]
mod configuration;
#[path = "connections/methods.rs"]
mod connections;
#[path = "discovery/methods.rs"]
mod discovery;
#[path = "editor/methods.rs"]
mod editor;
#[path = "events/methods.rs"]
mod events;
#[path = "execution/methods.rs"]
mod execution;
#[path = "files/browser/methods.rs"]
mod file_browser;
#[path = "files/content/methods.rs"]
mod file_content;
#[path = "files/methods.rs"]
mod files;
#[path = "forwarding/methods.rs"]
mod forwarding;
#[path = "history/methods.rs"]
mod history;
#[path = "hosts/methods.rs"]
mod hosts;
#[path = "logging/methods.rs"]
mod logging;
#[path = "monitor/methods.rs"]
mod monitor;
#[path = "mounts/methods.rs"]
mod mounts;
#[path = "settings/preferences/methods.rs"]
mod preferences;
#[path = "settings/profiles/methods.rs"]
mod profiles;
#[path = "runtime/methods.rs"]
mod runtime;
#[path = "settings/methods.rs"]
mod settings;
#[path = "storage/methods.rs"]
mod storage;
#[path = "terminal/methods.rs"]
mod terminal;
#[path = "tools/methods.rs"]
mod tools;
#[path = "workbench/methods.rs"]
mod workbench;

const DOMAINS: &[&[ApiMethod]] = &[
    runtime::METHODS,
    configuration::METHODS,
    discovery::METHODS,
    hosts::METHODS,
    workbench::METHODS,
    editor::METHODS,
    mounts::METHODS,
    forwarding::METHODS,
    execution::METHODS,
    events::METHODS,
    storage::METHODS,
    tools::METHODS,
    logging::METHODS,
    application::METHODS,
    settings::METHODS,
    preferences::METHODS,
    profiles::METHODS,
    connections::METHODS,
    terminal::METHODS,
    files::METHODS,
    file_browser::METHODS,
    file_content::METHODS,
    monitor::METHODS,
    history::METHODS,
    clipboard::METHODS,
];

pub static METHODS: LazyLock<Vec<ApiMethod>> = LazyLock::new(|| {
    DOMAINS
        .iter()
        .flat_map(|domain| domain.iter().copied())
        .collect()
});
