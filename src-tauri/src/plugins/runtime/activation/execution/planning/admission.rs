use std::collections::BTreeMap;

use super::super::super::{contracts::PackagePermit, limits::MAX_PACKAGES};
use super::{AdmittedPackage, AdmittedPlan};
use crate::{
    error::{AppError, AppResult},
    plugins::{security::Lease, PackageReview, PluginInfo, PluginsManager, StartPermit},
};

impl PluginsManager {
    pub fn prepare_start(&self, id: &str, expected_fingerprint: &str) -> AppResult<StartPermit> {
        self.prepare_reviewed_start(id, expected_fingerprint, &[])
    }

    /// Dependency declarations cannot use the legacy single-package admission
    /// path: every reviewed identity must match after all approval waits.
    pub fn prepare_reviewed_start(
        &self,
        id: &str,
        expected_fingerprint: &str,
        reviewed: &[PackageReview],
    ) -> AppResult<StartPermit> {
        let metadata = self.activation_metadata(id, expected_fingerprint)?;
        if reviewed.is_empty() {
            if metadata.graph.steps.len() != 1 {
                return Err(AppError::validation("pluginSecurity.changed"));
            }
        } else if reviewed.len() != metadata.graph.steps.len()
            || reviewed
                .iter()
                .zip(&metadata.graph.steps)
                .any(|(review, step)| {
                    review.id != step.package.id || review.fingerprint != step.package.fingerprint
                })
        {
            return Err(AppError::validation("pluginSecurity.changed"));
        }
        let mut grants = BTreeMap::new();
        for (id, info) in &metadata.packages {
            grants.insert(id.clone(), self.capture_activation_lease(info)?);
        }
        let mut permit = StartPermit::single(&self.security, &grants[id]);
        for step in &metadata.graph.steps {
            if step.package.id != id {
                let lease = &grants[&step.package.id];
                permit.packages.push(PackagePermit {
                    id: lease.id.clone(),
                    fingerprint: lease.fingerprint.clone(),
                    stamp: self.security.lease_stamp(lease),
                });
            }
        }
        Ok(permit)
    }

    /// Capture every original grant synchronously, before any lock, runtime
    /// probe or other asynchronous wait can lend a later approval to this call.
    pub(in crate::plugins::runtime::activation::execution) fn admit_graph(
        &self,
        id: &str,
        permit: &StartPermit,
    ) -> AppResult<AdmittedPlan> {
        let root = self.admitted_start(id, permit)?;
        if permit.packages.len() >= MAX_PACKAGES {
            return Err(AppError::validation("plugin.activation.limit"));
        }
        let metadata = self.activation_metadata(id, &root.fingerprint)?;
        if metadata.graph.steps.len() != permit.packages.len() + 1 {
            return Err(AppError::validation("pluginSecurity.changed"));
        }
        let mut grants = BTreeMap::new();
        let mut approvals = permit.packages.iter();
        for step in &metadata.graph.steps {
            let lease = self.capture_activation_lease(&metadata.packages[&step.package.id])?;
            if lease.id == id {
                if lease != root {
                    return Err(AppError::validation("pluginSecurity.changed"));
                }
            } else {
                let expected = approvals
                    .next()
                    .ok_or_else(|| AppError::validation("pluginSecurity.changed"))?;
                if expected.id != lease.id
                    || expected.fingerprint != lease.fingerprint
                    || expected.stamp != self.security.lease_stamp(&lease)
                {
                    return Err(AppError::validation("pluginSecurity.changed"));
                }
            }
            grants.insert(lease.id.clone(), lease);
        }
        let packages = metadata
            .graph
            .steps
            .iter()
            .map(|step| {
                let lease = grants[&step.package.id].clone();
                AdmittedPackage {
                    snapshot: metadata.packages[&step.package.id].clone(),
                    permit: StartPermit::single(&self.security, &lease),
                    lease,
                    required: step
                        .dependencies
                        .iter()
                        .map(|dependency| grants[&dependency.package.id].clone())
                        .collect(),
                }
            })
            .collect();
        Ok(AdmittedPlan {
            root,
            graph: metadata.graph,
            packages,
        })
    }

    fn capture_activation_lease(&self, info: &PluginInfo) -> AppResult<Lease> {
        let result = (|| {
            let lease = self.security.lease(
                &info.id,
                info.fingerprint.clone(),
                info.permissions.clone(),
            )?;
            if info.frontend.is_some() {
                self.security.authorize(
                    &lease.id,
                    &lease.fingerprint,
                    &lease.permissions,
                    Some("ui.trusted"),
                    Some(lease.generation),
                )?;
            }
            Ok(lease)
        })();
        result.map_err(|error| super::failure(&info.id, "approval", error))
    }
}
