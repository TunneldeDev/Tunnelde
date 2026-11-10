//! Preparation performs no plugin activation and registers no live resources.
//! Keep package checks and runtime selection reusable by the graph executor.
mod blocking;
mod node;
mod package;

use std::{path::Path, sync::Arc};

use crate::{
    db::Database,
    error::AppResult,
    plugins::{
        manifest,
        security::{Lease, PluginSecurity},
        wasm::WasmPlugin,
        PluginInfo, PluginStatus,
    },
};

use node::PreparedNode;

pub(super) enum PreparedEngine {
    Passive,
    Wasm(Option<WasmPlugin>),
    ExistingNode,
    Node(PreparedNode),
}

pub(super) struct Environment<'a> {
    node: node::Resolver<'a>,
}

impl<'a> Environment<'a> {
    pub(super) fn new(db: &'a Database, runtimes: &'a Path) -> Self {
        Self {
            node: node::Resolver::new(db, runtimes),
        }
    }
}

pub(super) use package::check as revalidate_package;

/// The caller retains the package read lock. Immutable installed metadata
/// avoids waiting for an initializing engine's instance lock before joining it.
/// Preparation neither lends a newer grant nor retires the captured one when
/// a version, package, or Node check fails.
pub(super) async fn prepare(
    security: &Arc<PluginSecurity>,
    lease: &Lease,
    instance: &PluginInfo,
    environment: &mut Environment<'_>,
) -> AppResult<PreparedEngine> {
    security
        .guard(lease, async {
            package::check(instance, lease).await?;
            let manifest = &instance.package_manifest;
            manifest.require_runtime()?;
            if let Some(frontend) = &manifest.frontend {
                security.authorize(
                    &lease.id,
                    &lease.fingerprint,
                    &lease.permissions,
                    Some("ui.trusted"),
                    Some(lease.generation),
                )?;
                frontend.require_sdk()?;
            }
            let same_runtime = instance.status == PluginStatus::Running
                && instance.runtime_id.as_deref() == Some(security.lease_stamp(lease).as_str());
            match manifest.runtime.as_deref() {
                Some("declarative" | "frontend") => Ok(PreparedEngine::Passive),
                Some("wasm") => {
                    let wasm = if !same_runtime {
                        let entry = manifest::entry_path(
                            std::path::Path::new(&instance.path),
                            &manifest.main,
                        )?;
                        Some(blocking::run(move || WasmPlugin::load(&std::fs::read(entry)?)).await?)
                    } else {
                        None
                    };
                    Ok(PreparedEngine::Wasm(wasm))
                }
                _ if same_runtime => Ok(PreparedEngine::ExistingNode),
                _ => Ok(PreparedEngine::Node(
                    environment.node.prepare(manifest).await?,
                )),
            }
        })
        .await
}

#[cfg(test)]
mod tests;
