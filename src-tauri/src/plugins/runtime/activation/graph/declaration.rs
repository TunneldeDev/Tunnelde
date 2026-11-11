use std::collections::BTreeMap;

use semver::VersionReq;

use super::super::{
    contracts::{DeclarationIssue, Dependency, Issue, Limit},
    MAX_DEPENDENCIES, MAX_RANGE_BYTES,
};
use crate::plugins::manifest::valid_id;

/// Validate before sorting so the diagnostic index refers to the declaration.
/// Ordinary plugin ranges intentionally do not use host beta eligibility rules.
pub(super) struct Range<'a> {
    pub declared: &'a str,
    pub parsed: VersionReq,
}

pub(super) fn parse<'a>(
    owner: &str,
    dependencies: &'a [Dependency],
) -> Result<BTreeMap<&'a str, Range<'a>>, Issue> {
    if dependencies.len() > MAX_DEPENDENCIES {
        return Err(Issue::Limit {
            kind: Limit::Dependencies,
            maximum: MAX_DEPENDENCIES,
        });
    }
    let mut parsed = BTreeMap::new();
    for (index, dependency) in dependencies.iter().enumerate() {
        let invalid = |reason| Issue::InvalidDeclaration {
            owner: owner.into(),
            index,
            reason,
        };
        if !valid_id(&dependency.id) {
            return Err(invalid(DeclarationIssue::InvalidId));
        }
        if dependency.id == owner {
            return Err(invalid(DeclarationIssue::SelfDependency));
        }
        if parsed.contains_key(dependency.id.as_str()) {
            return Err(invalid(DeclarationIssue::Duplicate));
        }
        let range = &dependency.version;
        if range.is_empty()
            || range.len() > MAX_RANGE_BYTES
            || range.trim() != range
            || range.chars().any(char::is_control)
        {
            return Err(invalid(DeclarationIssue::InvalidVersionRange));
        }
        let parsed_range =
            VersionReq::parse(range).map_err(|_| invalid(DeclarationIssue::InvalidVersionRange))?;
        parsed.insert(
            dependency.id.as_str(),
            Range {
                declared: range,
                parsed: parsed_range,
            },
        );
    }
    Ok(parsed)
}
