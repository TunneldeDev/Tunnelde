use std::collections::BTreeMap;

use super::super::{
    contracts::{Issue, Limit, Package, Plan, ResolvedDependency, Step},
    MAX_DEPTH, MAX_EDGES, MAX_PACKAGES,
};
use super::{catalogue::Catalogue, declaration};
use crate::plugins::manifest::{normalized_version, valid_id};

enum Visit {
    Pending,
    Done { height: usize },
}

struct Resolver {
    catalogue: Catalogue,
    visited: BTreeMap<String, Visit>,
    chain: Vec<String>,
    steps: Vec<Step>,
    edges: usize,
}

pub(in crate::plugins::runtime::activation) fn resolve(
    root: &str,
    packages: impl IntoIterator<Item = Package>,
) -> Result<Plan, Issue> {
    if !valid_id(root) {
        return Err(Issue::InvalidRoot);
    }
    let mut resolver = Resolver {
        catalogue: Catalogue::new(packages)?,
        visited: BTreeMap::new(),
        chain: Vec::new(),
        steps: Vec::new(),
        edges: 0,
    };
    resolver.visit(root)?;
    Ok(Plan {
        root: root.into(),
        steps: resolver.steps,
    })
}

/// Re-resolve from authoritative metadata. Do not hash or trust a caller's copy
/// of the plan. Unrelated package changes do not invalidate a user's approval.
pub(in crate::plugins::runtime::activation) fn revalidate(
    plan: &Plan,
    packages: impl IntoIterator<Item = Package>,
) -> Result<(), Issue> {
    let current = resolve(&plan.root, packages)?;
    if current != *plan {
        return Err(Issue::PlanChanged {
            root: plan.root.clone(),
        });
    }
    Ok(())
}

impl Resolver {
    fn visit(&mut self, id: &str) -> Result<usize, Issue> {
        match self.visited.get(id) {
            Some(Visit::Done { height }) => return Ok(*height),
            Some(Visit::Pending) => {
                let mut chain = self.chain.clone();
                chain.push(id.into());
                return Err(Issue::Cycle { chain });
            }
            None => {}
        }
        if self.visited.len() >= MAX_PACKAGES {
            return Err(Issue::Limit {
                kind: Limit::Packages,
                maximum: MAX_PACKAGES,
            });
        }
        if self.chain.len() >= MAX_DEPTH {
            return Err(Issue::Limit {
                kind: Limit::Depth,
                maximum: MAX_DEPTH,
            });
        }
        self.chain.push(id.into());
        let package = self.catalogue.get(id, &self.chain)?;
        let requirements = declaration::parse(id, &package.dependencies)?;
        self.edges += requirements.len();
        if self.edges > MAX_EDGES {
            return Err(Issue::Limit {
                kind: Limit::Edges,
                maximum: MAX_EDGES,
            });
        }
        // Own only this bounded node while descending, not the entire catalogue.
        let identity = package.identity.clone();
        let mut resolved = Vec::with_capacity(requirements.len());
        for (dependency, range) in requirements {
            let mut chain = self.chain.clone();
            chain.push(dependency.into());
            let dependency_package = self.catalogue.get(dependency, &chain)?;
            if !range
                .parsed
                .matches(&normalized_version(&dependency_package.identity.version).unwrap())
            {
                return Err(Issue::Incompatible {
                    owner: id.into(),
                    id: dependency.into(),
                    required: range.declared.into(),
                    installed: dependency_package.identity.version.clone(),
                    chain,
                });
            }
            resolved.push(ResolvedDependency {
                package: dependency_package.identity.clone(),
                required: range.declared.into(),
            });
        }
        self.visited.insert(id.into(), Visit::Pending);
        let mut height = 1;
        for dependency in &resolved {
            height = height.max(self.visit(&dependency.package.id)? + 1);
        }
        // Checking only the recursion stack misses a longer path through an
        // already resolved shared dependency. Its height must count as well.
        if height > MAX_DEPTH {
            return Err(Issue::Limit {
                kind: Limit::Depth,
                maximum: MAX_DEPTH,
            });
        }
        self.visited.insert(id.into(), Visit::Done { height });
        self.chain.pop();
        self.steps.push(Step {
            package: identity,
            dependencies: resolved,
        });
        Ok(height)
    }
}
