use super::PackageIdentity;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(in crate::plugins::runtime::activation) struct ResolvedDependency {
    pub package: PackageIdentity,
    pub required: String,
}

/// One deterministic dependencies-first sequence. Package identities on every
/// edge prevent a later same-version replacement from reusing an approved plan.
/// Running generations are bound at execution, not in this read-only snapshot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(in crate::plugins::runtime::activation) struct Plan {
    pub root: String,
    pub steps: Vec<Step>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(in crate::plugins::runtime::activation) struct Step {
    pub package: PackageIdentity,
    pub dependencies: Vec<ResolvedDependency>,
}
