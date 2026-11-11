use std::collections::BTreeSet;

use super::super::{normalized, Lease, PluginSecurity, Policy};
use super::{
    authorization,
    model::{Binding, Phase},
};
use crate::error::{AppError, AppResult};
use crate::plugins::runtime::activation::limits::MAX_DEPENDENCIES;

/// Return ownership only for a newly inserted binding. A repeated start may
/// observe an existing ready engine but must never acquire its rollback guard.
pub(super) fn prepare(
    policy: &mut Policy,
    lease: &Lease,
    required: &[Lease],
    frontend: bool,
) -> AppResult<bool> {
    PluginSecurity::authorize_policy(
        policy,
        &lease.id,
        &lease.fingerprint,
        &lease.permissions,
        None,
        Some(lease.generation),
    )?;
    if required.len() > MAX_DEPENDENCIES {
        return Err(AppError::validation("plugin.activation.limit"));
    }
    let mut ids = BTreeSet::new();
    let mut dependencies = required.to_vec();
    dependencies.sort_by(|left, right| left.id.cmp(&right.id));
    for dependency in &mut dependencies {
        if dependency.id == lease.id || !ids.insert(dependency.id.clone()) {
            return Err(AppError::validation(
                "plugin.activation.invalidDependencies",
            ));
        }
        dependency.permissions = normalized(&dependency.permissions);
        PluginSecurity::authorize_policy(
            policy,
            &dependency.id,
            &dependency.fingerprint,
            &dependency.permissions,
            None,
            Some(dependency.generation),
        )?;
        if !policy
            .runtimes
            .0
            .get(&dependency.id)
            .is_some_and(|binding| binding.matches(dependency) && binding.phase == Phase::Ready)
        {
            return Err(AppError::validation(
                "plugin.activation.dependencyUnavailable",
            ));
        }
    }
    let mut lease = lease.clone();
    lease.permissions = normalized(&lease.permissions);
    if let Some(existing) = policy.runtimes.0.get(&lease.id) {
        return if existing.matches(&lease)
            && existing.dependencies == dependencies
            && existing.frontend == frontend
        {
            if existing.phase == Phase::Starting {
                Err(AppError::validation("plugin.activation.busy"))
            } else {
                Ok(false)
            }
        } else {
            Err(AppError::validation("pluginSecurity.changed"))
        };
    }
    if policy.runtimes.0.len() >= 256 {
        return Err(AppError::validation("plugin.activation.limit"));
    }
    let id = lease.id.clone();
    let fingerprint = lease.fingerprint.clone();
    let generation = lease.generation;
    policy.runtimes.0.insert(
        id.clone(),
        Binding {
            lease,
            dependencies,
            frontend,
            phase: Phase::Starting,
            frontend_token: None,
            readiness_id: uuid::Uuid::new_v4(),
        },
    );
    if let Err(error) = authorization::validate(policy, &id, &fingerprint, generation) {
        policy.runtimes.0.remove(&id);
        return Err(error);
    }
    Ok(true)
}

pub(super) fn binding<'a>(policy: &'a mut Policy, lease: &Lease) -> AppResult<&'a mut Binding> {
    PluginSecurity::authorize_policy(
        policy,
        &lease.id,
        &lease.fingerprint,
        &lease.permissions,
        None,
        Some(lease.generation),
    )?;
    policy
        .runtimes
        .0
        .get_mut(&lease.id)
        .filter(|binding| binding.matches(lease))
        .ok_or_else(|| AppError::validation("pluginSecurity.changed"))
}

pub(super) fn native_ready(policy: &mut Policy, lease: &Lease) -> AppResult<()> {
    let binding = binding(policy, lease)?;
    if binding.phase == Phase::Starting {
        binding.phase = if binding.frontend {
            Phase::AwaitingFrontend
        } else {
            Phase::Ready
        };
    }
    Ok(())
}
