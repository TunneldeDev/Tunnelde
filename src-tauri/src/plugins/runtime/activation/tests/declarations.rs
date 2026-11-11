use super::super::{
    contracts::{DeclarationIssue, Issue, PackageField},
    graph::resolve,
    MAX_RANGE_BYTES,
};
use super::package;

#[test]
fn rejects_ambiguous_catalogue_and_invalid_root_before_planning() {
    assert_eq!(resolve("../plugin", []), Err(Issue::InvalidRoot));
    assert_eq!(resolve("", []), Err(Issue::InvalidRoot));
    assert_eq!(
        resolve("root", [package("root", &[]), package("root", &[])]),
        Err(Issue::AmbiguousPackage { id: "root".into() })
    );
    assert_eq!(
        resolve("root", [package("bad.id", &[])]),
        Err(Issue::InvalidPackage {
            id: String::new(),
            field: PackageField::Id
        })
    );
}

#[test]
fn validates_identity_without_returning_invalid_unbounded_values() {
    for version in ["invalid".into(), "1".repeat(MAX_RANGE_BYTES + 1)] {
        let mut root = package("root", &[]);
        root.identity.version = version;
        assert_eq!(
            resolve("root", [root]),
            Err(Issue::InvalidPackage {
                id: "root".into(),
                field: PackageField::Version
            })
        );
    }
    for fingerprint in [
        String::new(),
        "a".repeat(63),
        "a".repeat(65),
        "g".repeat(64),
    ] {
        let mut root = package("root", &[]);
        root.identity.fingerprint = fingerprint;
        assert_eq!(
            resolve("root", [root]),
            Err(Issue::InvalidPackage {
                id: "root".into(),
                field: PackageField::Fingerprint
            })
        );
    }
}

#[test]
fn rejects_invalid_duplicate_and_self_dependencies_with_declaration_index() {
    for (dependencies, index, reason) in [
        (vec![("bad.id", "*")], 0, DeclarationIssue::InvalidId),
        (vec![("root", "*")], 0, DeclarationIssue::SelfDependency),
        (
            vec![("shared", "*"), ("shared", "^1")],
            1,
            DeclarationIssue::Duplicate,
        ),
    ] {
        assert_eq!(
            resolve("root", [package("root", &dependencies)]),
            Err(Issue::InvalidDeclaration {
                owner: "root".into(),
                index,
                reason
            })
        );
    }
}

#[test]
fn version_ranges_are_bounded_and_use_the_existing_rust_semver_syntax() {
    for range in [
        "",
        "  *",
        "* ",
        ">=1.0.0\n",
        ">=1.0.0\t, <2.0.0",
        "1 || 2",
        "garbage",
    ] {
        assert_eq!(
            resolve("root", [package("root", &[("shared", range)])]),
            Err(Issue::InvalidDeclaration {
                owner: "root".into(),
                index: 0,
                reason: DeclarationIssue::InvalidVersionRange
            })
        );
    }
    let oversized = "a".repeat(MAX_RANGE_BYTES + 1);
    assert_eq!(
        resolve("root", [package("root", &[("shared", &oversized)])]),
        Err(Issue::InvalidDeclaration {
            owner: "root".into(),
            index: 0,
            reason: DeclarationIssue::InvalidVersionRange
        })
    );
    for range in ["*", "^1.0", "~1.0", ">=1.0.0, <2.0.0", "=1.0.0"] {
        assert!(
            resolve(
                "root",
                [
                    package("root", &[("shared", range)]),
                    package("shared", &[])
                ]
            )
            .is_ok(),
            "{range}"
        );
    }
}

#[test]
fn normalizes_legacy_installed_versions_without_silently_admitting_prereleases() {
    let mut shared = package("shared", &[]);
    shared.identity.version = "1.2".into();
    let plan = resolve("root", [package("root", &[("shared", "^1.1")]), shared]).unwrap();
    assert_eq!(plan.steps[0].package.version, "1.2");
    for range in ["*", ">=1.0.0", "^1.0"] {
        let mut shared = package("shared", &[]);
        shared.identity.version = "1.2.0-beta.1".into();
        assert!(
            matches!(
                resolve("root", [package("root", &[("shared", range)]), shared]),
                Err(Issue::Incompatible { .. })
            ),
            "{range}"
        );
    }
    let mut shared = package("shared", &[]);
    shared.identity.version = "1.2.0-beta.1".into();
    assert!(resolve(
        "root",
        [
            package("root", &[("shared", ">=1.2.0-beta.1, <2.0.0")]),
            shared
        ]
    )
    .is_ok());
}
