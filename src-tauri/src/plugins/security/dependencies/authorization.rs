use std::collections::BTreeMap;

use super::super::{Lease, PluginSecurity, Policy};
use super::model::Phase;
use crate::error::{AppError, AppResult};
use crate::plugins::runtime::activation::limits::{MAX_DEPTH, MAX_EDGES, MAX_PACKAGES};

pub(in crate::plugins::security) fn validate(
    policy: &Policy,
    id: &str,
    fingerprint: &str,
    generation: u64,
) -> AppResult<()> {
    let Some(binding) = policy.runtimes.0.get(id) else {
        return Ok(());
    };
    if binding.lease.fingerprint != fingerprint || binding.lease.generation != generation {
        return Err(AppError::validation("pluginSecurity.changed"));
    }
    // The owner may call host APIs during initialize/activate. Required runtimes
    // must already be ready; approval alone cannot stand in for activation.
    let mut edges = 0;
    check(
        policy,
        &binding.lease,
        false,
        &mut BTreeMap::new(),
        &mut Vec::new(),
        &mut edges,
    )
    .map(|_| ())
}

fn check(
    policy: &Policy,
    lease: &Lease,
    ready: bool,
    checked: &mut BTreeMap<String, usize>,
    path: &mut Vec<String>,
    edges: &mut usize,
) -> AppResult<usize> {
    let unavailable = || AppError::validation("plugin.activation.dependencyUnavailable");
    PluginSecurity::authorize_grant(
        policy,
        &lease.id,
        &lease.fingerprint,
        &lease.permissions,
        None,
        Some(lease.generation),
    )
    .map_err(|_| unavailable())?;
    let binding = policy
        .runtimes
        .0
        .get(&lease.id)
        .filter(|binding| binding.matches(lease))
        .ok_or_else(unavailable)?;
    if ready && binding.phase != Phase::Ready {
        return Err(unavailable());
    }
    if path.contains(&lease.id) || path.len() >= MAX_DEPTH {
        return Err(unavailable());
    }
    // A cached subtree is valid only when its full height also fits this path.
    // Merely checking the current stack misses longer paths through a diamond.
    if let Some(&height) = checked.get(&lease.id) {
        if path.len() + height > MAX_DEPTH {
            return Err(unavailable());
        }
        return Ok(height);
    }
    if checked.len() + path.len() >= MAX_PACKAGES {
        return Err(unavailable());
    }
    *edges += binding.dependencies.len();
    if *edges > MAX_EDGES {
        return Err(unavailable());
    }
    path.push(lease.id.clone());
    let mut height = 1;
    for dependency in &binding.dependencies {
        height = height.max(1 + check(policy, dependency, true, checked, path, edges)?);
    }
    path.pop();
    if path.len() + height > MAX_DEPTH {
        return Err(unavailable());
    }
    checked.insert(lease.id.clone(), height);
    Ok(height)
}
