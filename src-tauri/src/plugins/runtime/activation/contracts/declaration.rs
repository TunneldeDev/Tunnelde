/// Required runtime dependencies only. Optional discovery and JS module imports
/// have different semantics and do not belong in the activation graph.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(in crate::plugins::runtime::activation) struct Dependency {
    pub id: String,
    pub version: String,
}

/// Identity of the installed bytes, not a claim about approval or live readiness.
/// Preserve the original version string for equality and diagnostics; matching
/// accepts the same legacy two-component versions as installed manifests.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(in crate::plugins::runtime::activation) struct PackageIdentity {
    pub id: String,
    pub version: String,
    pub fingerprint: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(in crate::plugins::runtime::activation) struct Package {
    pub identity: PackageIdentity,
    pub dependencies: Vec<Dependency>,
}
