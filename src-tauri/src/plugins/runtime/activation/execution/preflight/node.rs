use std::path::Path;

use crate::{
    db::Database,
    error::{AppError, AppResult},
    plugins::{
        config::{self, PluginConfig},
        manifest::PluginManifest,
        node::{self, NodeRuntimeInfo},
    },
};

pub(in crate::plugins::runtime::activation::execution) struct PreparedNode {
    path: String,
    source: String,
    selected_path: Option<String>,
}

pub(super) struct Resolver<'a> {
    db: &'a Database,
    runtimes: &'a Path,
    resolved: Option<(PluginConfig, NodeRuntimeInfo)>,
}

impl<'a> Resolver<'a> {
    pub(super) fn new(db: &'a Database, runtimes: &'a Path) -> Self {
        Self {
            db,
            runtimes,
            resolved: None,
        }
    }

    pub(super) async fn prepare(&mut self, manifest: &PluginManifest) -> AppResult<PreparedNode> {
        if self.resolved.is_none() {
            let config = self.db.with(config::load)?;
            let runtime = node::resolve(
                self.runtimes,
                config.node_path.as_deref().map(Path::new),
                config.node_system_allowed,
            )
            .await?;
            self.resolved = Some((config, runtime));
        }
        let (config, runtime) = self.resolved.as_ref().expect("runtime resolved above");
        let prepared = PreparedNode::checked(config, manifest, runtime.clone())?;
        prepared.revalidate(self.db)?;
        Ok(prepared)
    }
}

impl PreparedNode {
    fn checked(
        config: &PluginConfig,
        manifest: &PluginManifest,
        runtime: NodeRuntimeInfo,
    ) -> AppResult<Self> {
        if !runtime.compatible {
            return Err(AppError::validation("node.required"));
        }
        let path = runtime
            .path
            .filter(|path| Path::new(path).is_absolute())
            .ok_or_else(|| AppError::validation("node.required"))?;
        if let Some(range) = manifest.engines.get("node") {
            let version = runtime
                .version
                .as_deref()
                .and_then(|value| semver::Version::parse(value.trim_start_matches('v')).ok());
            if !version.is_some_and(|version| {
                semver::VersionReq::parse(range).is_ok_and(|req| req.matches(&version))
            }) {
                return Err(AppError::validation("node.incompatible"));
            }
        }
        let prepared = Self {
            path,
            source: runtime
                .source
                .ok_or_else(|| AppError::validation("node.required"))?,
            selected_path: config.node_path.clone(),
        };
        prepared.check_policy(config)?;
        Ok(prepared)
    }

    /// Re-check immediately before spawn. A runtime choice or system consent
    /// captured before an asynchronous wait cannot lend a later authorization.
    pub(in crate::plugins::runtime::activation::execution) fn revalidate(
        &self,
        db: &Database,
    ) -> AppResult<()> {
        self.check_policy(&db.with(config::load)?)
    }

    pub(in crate::plugins::runtime::activation::execution) fn path(&self) -> &str {
        &self.path
    }

    pub(in crate::plugins::runtime::activation::execution) fn source(&self) -> &str {
        &self.source
    }

    fn check_policy(&self, config: &PluginConfig) -> AppResult<()> {
        if config.node_path != self.selected_path {
            return Err(AppError::validation("pluginSecurity.changed"));
        }
        let allowed = match self.source.as_str() {
            "explicit" => config.node_path.is_some(),
            "managed" => config.node_path.is_none(),
            "environment" | "path" | "registry" | "shell" => {
                config.node_path.is_none() && config.node_system_allowed
            }
            _ => false,
        };
        if !allowed {
            return Err(AppError::validation("node.required"));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests;
