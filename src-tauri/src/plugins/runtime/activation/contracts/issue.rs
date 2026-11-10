#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(in crate::plugins::runtime::activation) enum Limit {
    Catalogue,
    Dependencies,
    Packages,
    Edges,
    Depth,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(in crate::plugins::runtime::activation) enum DeclarationIssue {
    InvalidId,
    InvalidVersionRange,
    Duplicate,
    SelfDependency,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(in crate::plugins::runtime::activation) enum PackageField {
    Id,
    Version,
    Fingerprint,
}

/// Structured, bounded failures. No paths, process output, or permissions are
/// included; the UI adapter can localize these after the runtime is integrated.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(in crate::plugins::runtime::activation) enum Issue {
    InvalidRoot,
    Limit {
        kind: Limit,
        maximum: usize,
    },
    AmbiguousPackage {
        id: String,
    },
    InvalidPackage {
        id: String,
        field: PackageField,
    },
    InvalidDeclaration {
        owner: String,
        index: usize,
        reason: DeclarationIssue,
    },
    Missing {
        id: String,
        chain: Vec<String>,
    },
    Incompatible {
        owner: String,
        id: String,
        required: String,
        installed: String,
        chain: Vec<String>,
    },
    Cycle {
        chain: Vec<String>,
    },
    PlanChanged {
        root: String,
    },
}
