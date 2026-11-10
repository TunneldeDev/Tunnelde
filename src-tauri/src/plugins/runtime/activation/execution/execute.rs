use tauri::{AppHandle, Manager};

use super::{
    planning::{self, AdmittedPackage, AdmittedPlan},
    preflight::{self, Environment, PreparedEngine},
};
use crate::{
    error::AppResult,
    plugins::{PluginInfo, PluginsManager, StartPermit},
    state::AppState,
};

pub(super) struct PreparedPackage {
    pub admission: AdmittedPackage,
    pub engine: PreparedEngine,
}

impl PluginsManager {
    pub async fn start(
        &self,
        app: &AppHandle,
        id: &str,
        permit: &StartPermit,
    ) -> AppResult<PluginInfo> {
        let plan = self.admit_graph(id, permit)?;
        let _request = self.starts.admit_request()?;
        let root = plan.root.clone();
        let packages = self.preflight_graph(app, plan).await?;
        for package in packages {
            if package.admission.lease.id == root.id {
                // Root initialization can retire its own failed runtime. Its
                // shared startup ticket must finish settlement and preserve the
                // original failure, rather than an outer guard masking it.
                return self.start_one(app, package).await;
            }
            let dependency_id = package.admission.lease.id.clone();
            let info = self
                .security
                .guard(&root, self.start_one(app, package))
                .await
                .map_err(|error| planning::failure(&dependency_id, "initialize", error))?;
            if info.status != crate::plugins::PluginStatus::Running {
                return Err(planning::failure(
                    &dependency_id,
                    "initialize",
                    crate::error::AppError::validation(
                        info.error
                            .unwrap_or_else(|| "plugin.activation.dependencyUnavailable".into()),
                    ),
                ));
            }
        }
        Err(crate::error::AppError::internal(
            "plugin.activation.invalidDependencies",
        ))
    }

    pub(super) async fn preflight_graph(
        &self,
        app: &AppHandle,
        plan: AdmittedPlan,
    ) -> AppResult<Vec<PreparedPackage>> {
        let state = app.state::<AppState>();
        tokio::time::timeout(
            std::time::Duration::from_millis(super::super::limits::PREFLIGHT_TIMEOUT_MS),
            self.prepare_graph(
                plan,
                &state.db,
                state
                    .storage
                    .dir(crate::storage::layout::Category::Runtimes),
            ),
        )
        .await
        .map_err(|_| crate::error::AppError::validation("plugin.timeout"))?
    }

    /// No plugin engine starts until every original grant, authoritative
    /// package and runtime in this plan has passed. Release the package read
    /// lock before any engine or frontend readiness wait.
    pub(super) async fn prepare_graph(
        &self,
        plan: AdmittedPlan,
        db: &crate::db::Database,
        runtimes: &std::path::Path,
    ) -> AppResult<Vec<PreparedPackage>> {
        let root = plan.root.clone();
        self.security
            .guard(&root, async {
                let _packages = self.mutations.read().await;
                self.revalidate_graph(&plan.graph)?;
                let mut environment = Environment::new(db, runtimes);
                let mut prepared = Vec::with_capacity(plan.packages.len());
                for admission in plan.packages {
                    let id = &admission.lease.id;
                    let engine = preflight::prepare(
                        &self.security,
                        &admission.lease,
                        &admission.snapshot,
                        &mut environment,
                    )
                    .await
                    .map_err(|error| planning::failure(id, "preflight", error))?;
                    prepared.push(PreparedPackage { admission, engine });
                }
                self.revalidate_graph(&plan.graph)?;
                // A grant checked early in this graph may have been revoked while
                // a later package was being hashed, compiled or probed. Validate
                // the entire original set again before the first engine starts.
                for package in &prepared {
                    self.admitted_start(&package.admission.lease.id, &package.admission.permit)
                        .map_err(|error| {
                            planning::failure(&package.admission.lease.id, "approval", error)
                        })?;
                }
                Ok(prepared)
            })
            .await
    }
}
