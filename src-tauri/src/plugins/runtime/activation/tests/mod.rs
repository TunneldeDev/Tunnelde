use super::contracts::{Dependency, Package, PackageIdentity, Plan};

mod bounds;
mod declarations;
mod discovery;
mod manifest;
mod resolution;
mod snapshots;

fn package(id: &str, dependencies: &[(&str, &str)]) -> Package {
    Package {
        identity: PackageIdentity {
            id: id.into(),
            version: "1.0.0".into(),
            fingerprint: "a".repeat(64),
        },
        dependencies: dependencies
            .iter()
            .map(|(id, version)| Dependency {
                id: (*id).into(),
                version: (*version).into(),
            })
            .collect(),
    }
}

fn names(plan: &Plan) -> Vec<&str> {
    plan.steps
        .iter()
        .map(|step| step.package.id.as_str())
        .collect()
}
