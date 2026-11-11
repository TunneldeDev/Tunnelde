use std::collections::BTreeMap;

use super::super::super::{
    contracts::{ActivationPackage, Issue, Package, PackageIdentity, Plan},
    graph,
};
use crate::{
    error::{AppError, AppResult},
    plugins::{ActivationPlan, PluginInfo, PluginsManager},
};

pub(super) struct Metadata {
    pub graph: Plan,
    pub packages: BTreeMap<String, PluginInfo>,
}

fn package(info: &PluginInfo) -> Package {
    Package {
        identity: PackageIdentity {
            id: info.id.clone(),
            version: info.version.clone(),
            fingerprint: info.fingerprint.clone(),
        },
        dependencies: info.dependencies.clone(),
    }
}

impl PluginsManager {
    pub fn activation_plan(&self, id: &str, fingerprint: &str) -> AppResult<ActivationPlan> {
        let metadata = self.activation_metadata(id, fingerprint)?;
        Ok(ActivationPlan {
            root: id.into(),
            packages: metadata
                .graph
                .steps
                .iter()
                .map(|step| ActivationPackage::from(&metadata.packages[&step.package.id]))
                .collect(),
        })
    }

    pub(in crate::plugins::runtime::activation::execution) fn revalidate_graph(
        &self,
        plan: &Plan,
    ) -> AppResult<()> {
        let snapshots = self
            .snapshots
            .read()
            .unwrap_or_else(|error| error.into_inner());
        graph::revalidate(plan, snapshots.values().map(package)).map_err(Issue::into_error)
    }

    pub(super) fn activation_metadata(&self, id: &str, fingerprint: &str) -> AppResult<Metadata> {
        let snapshots = self
            .snapshots
            .read()
            .unwrap_or_else(|error| error.into_inner());
        let root = snapshots
            .get(id)
            .ok_or_else(|| AppError::NotFound("plugin.notFound".into()))?;
        if fingerprint.is_empty() || root.fingerprint != fingerprint {
            return Err(AppError::validation("pluginSecurity.changed"));
        }
        let graph =
            graph::resolve(id, snapshots.values().map(package)).map_err(Issue::into_error)?;
        let mut packages = BTreeMap::new();
        for step in &graph.steps {
            let info = &snapshots[&step.package.id];
            if info.runtime == "theme" {
                return Err(super::failure(
                    &info.id,
                    "planning",
                    AppError::validation("plugin.theme.noRuntime"),
                ));
            }
            packages.insert(info.id.clone(), info.clone());
        }
        Ok(Metadata { graph, packages })
    }
}
