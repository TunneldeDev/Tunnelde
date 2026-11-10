//! Host ranges include prereleases while retaining each comparator's bounds.
//! Runtime (Node) ranges continue to use the runtime's ordinary SemVer rules.
impl super::manifest::PluginManifest {
    pub(super) fn require_runtime(&self) -> crate::error::AppResult<()> {
        if let Some(range) = self.engines.get("tunnelde") {
            if !supports_host(range, env!("CARGO_PKG_VERSION")) {
                return Err(crate::error::AppError::PluginEngineUnsupported {
                    plugin_id: self.id.clone(),
                    plugin_version: self.version.clone(),
                    host_version: env!("CARGO_PKG_VERSION").into(),
                    required: range.clone(),
                });
            }
        }
        if self.runtime.as_deref() == Some("theme") {
            return Err(crate::error::AppError::validation("plugin.theme.noRuntime"));
        }
        Ok(())
    }
}

pub(super) fn supports_host(range: &str, version: &str) -> bool {
    let (Ok(mut range), Ok(version)) = (
        semver::VersionReq::parse(range),
        semver::Version::parse(version),
    ) else {
        return false;
    };
    if !version.pre.is_empty() {
        // A comparator equal to the version under test cannot narrow its bounds,
        // but opts this tuple into semver's prerelease eligibility check. Unlike
        // stripping the suffix, this still rejects >=0.32.0 for 0.32.0-beta.4.
        range.comparators.push(semver::Comparator {
            op: semver::Op::GreaterEq,
            major: version.major,
            minor: Some(version.minor),
            patch: Some(version.patch),
            pre: version.pre.clone(),
        });
    }
    range.matches(&version)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn later_host_betas_satisfy_older_minimums_without_weakening_the_range() {
        for range in [
            ">=0.29.0-beta.2",
            ">=0.31.0",
            ">=0.29.0-beta.2, <1.0.0",
            "*",
        ] {
            assert!(supports_host(range, "0.32.0-beta.4"), "{range}");
        }
        for range in [
            ">=0.32.0",
            ">=0.32.0-beta.5",
            "=0.32.0-beta.3",
            "^0.31.0",
            "<0.31.0",
            "invalid",
        ] {
            assert!(!supports_host(range, "0.32.0-beta.4"), "{range}");
        }
        assert!(supports_host("=0.32.0-beta.4", "0.32.0-beta.4"));
        assert!(supports_host(">=0.29.0-beta.2", "0.32.0"));
        assert!(!supports_host(">=0.29.0-beta.2", "invalid"));
    }
}
