use std::collections::BTreeSet;

use super::super::Policy;

/// Captured under the policy lock. Cleanup must use this boundary, never read a
/// newer grant after a replacement runtime has already started.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(in crate::plugins) struct RuntimeRetirement {
    pub id: String,
    pub before_generation: u64,
}

/// Retire consumers, never prerequisites. The exact reverse closure is captured
/// before removing edges; a shared prerequisite survives a consumer stopping.
pub(in crate::plugins::security) fn retire(
    policy: &mut Policy,
    id: &str,
) -> Vec<RuntimeRetirement> {
    if !crate::plugins::manifest::valid_id(id) {
        return vec![];
    }
    retire_set(policy, consumers(policy, id, true))
}

pub(super) fn retire_consumers(policy: &mut Policy, id: &str) -> Vec<RuntimeRetirement> {
    retire_set(policy, consumers(policy, id, false))
}

fn consumers(policy: &Policy, id: &str, include_owner: bool) -> BTreeSet<String> {
    let mut affected = BTreeSet::from([id.to_owned()]);
    loop {
        let before = affected.len();
        for (owner, binding) in &policy.runtimes.0 {
            if binding
                .dependencies
                .iter()
                .any(|dependency| affected.contains(&dependency.id))
            {
                affected.insert(owner.clone());
            }
        }
        if affected.len() == before {
            break;
        }
    }
    if !include_owner {
        affected.remove(id);
    }
    affected
}

fn retire_set(policy: &mut Policy, affected: BTreeSet<String>) -> Vec<RuntimeRetirement> {
    if affected.is_empty() {
        return vec![];
    }
    policy.revision += 1;
    let generation = policy.revision;
    let mut retired = Vec::with_capacity(affected.len());
    for owner in affected {
        policy.runtimes.0.remove(&owner);
        if let Some(grant) = policy.saved.grants.get_mut(&owner) {
            grant.generation = generation;
        }
        retired.push(RuntimeRetirement {
            id: owner,
            before_generation: generation,
        });
    }
    retired
}
