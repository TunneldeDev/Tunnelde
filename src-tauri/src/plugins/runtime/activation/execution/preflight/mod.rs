//! Preparation performs no plugin activation and registers no live resources.
//! Keep package checks and runtime selection reusable by the graph executor.
mod node;
mod package;

use std::{path::Path, sync::Arc};

use crate::{
    db::Database,
    error::AppResult,
    plugins::{
        security::{Lease, PluginSecurity},
        wasm::WasmPlugin,
        Instance,
    },
};

use node::PreparedNode;

pub(super) enum PreparedEngine {
    Passive,
    Wasm(Option<WasmPlugin>),
    ExistingNode,
    Node(PreparedNode),
}

/// The caller retains the package read lock and the original instance lock.
/// Preparation neither lends a newer grant nor retires the captured one when
/// a version, package, or Node check fails.
pub(super) async fn prepare(
    security: &Arc<PluginSecurity>,
    lease: &Lease,
    instance: &Instance,
    db: &Database,
    runtimes: &Path,
) -> AppResult<PreparedEngine> {
    security
        .guard(lease, async {
            package::check(instance, lease).await?;
            instance.require_runtime()?;
            if let Some(frontend) = &instance.manifest.frontend {
                frontend.require_sdk()?;
            }
            let same_runtime = instance
                .runtime_lease
                .as_ref()
                .is_some_and(|active| active == lease);
            match instance.manifest.runtime.as_deref() {
                Some("declarative" | "frontend") => Ok(PreparedEngine::Passive),
                Some("wasm") => {
                    let wasm = if instance.wasm.is_none()
                        || instance.runtime_lease.is_some() && !same_runtime
                    {
                        Some(instance.load_wasm()?)
                    } else {
                        None
                    };
                    Ok(PreparedEngine::Wasm(wasm))
                }
                _ if same_runtime && instance.host.is_some() => Ok(PreparedEngine::ExistingNode),
                _ => Ok(PreparedEngine::Node(
                    PreparedNode::prepare(db, runtimes, &instance.manifest).await?,
                )),
            }
        })
        .await
}

#[cfg(test)]
mod tests;
