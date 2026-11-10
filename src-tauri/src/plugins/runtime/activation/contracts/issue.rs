#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::plugins::runtime::activation) enum Limit {
    Catalogue,
    Dependencies,
    Packages,
    Edges,
    Depth,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::plugins::runtime::activation) enum DeclarationIssue {
    InvalidId,
    InvalidVersionRange,
    Duplicate,
    SelfDependency,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::plugins::runtime::activation) enum PackageField {
    Id,
    Version,
    Fingerprint,
}

/// Structured, bounded failures. No paths, process output, or permissions are
/// included; the UI adapter can localize these after the runtime is integrated.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
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

impl Issue {
    pub(in crate::plugins::runtime::activation) fn into_error(self) -> crate::error::AppError {
        let reason = match &self {
            Self::Missing { .. } => "plugin.activation.missingDependency",
            Self::Incompatible { .. } => "plugin.activation.incompatibleDependency",
            Self::Cycle { .. } => "plugin.activation.cycle",
            Self::Limit { .. } => "plugin.activation.limit",
            Self::PlanChanged { .. } => "pluginSecurity.changed",
            _ => "plugin.activation.invalidDependencies",
        };
        crate::error::AppError::PluginActivation {
            reason,
            details: serde_json::to_value(self).expect("bounded activation issue is serializable"),
        }
    }
}
