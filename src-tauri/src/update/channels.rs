use semver::Version;

pub(super) fn accepts_version(current: &Version, candidate: &Version, channel: &str) -> bool {
    candidate > current && channel_accepts(candidate, channel)
}

pub(super) fn channel_accepts(candidate: &Version, channel: &str) -> bool {
    let pre = candidate.pre.as_str();
    let milestone = pre.split(".d.").next().unwrap_or(pre);
    let beta = milestone.starts_with("beta.")
        || milestone.strip_prefix("beta").is_some_and(|number| {
            number.len() == 2 && number != "00" && number.bytes().all(|byte| byte.is_ascii_digit())
        });
    candidate.pre.is_empty()
        || (["beta", "nightly"].contains(&channel) && beta && !pre.contains(".d."))
        || (channel == "nightly" && (pre.starts_with("alpha.") || (beta && pre.contains(".d."))))
}

pub(super) fn source_channels(channel: &str) -> &'static [&'static str] {
    match channel {
        "nightly" => &["stable", "beta", "nightly"],
        "beta" => &["stable", "beta"],
        _ => &["stable"],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stable_replacement_upgrades_installed_historical_betas_without_a_bridge() {
        let stable = Version::parse("0.28.0").unwrap();
        for installed in ["0.28.0-beta.9", "0.28.0-beta.10", "0.28.0-beta.11"] {
            let installed = Version::parse(installed).unwrap();
            for channel in ["stable", "beta", "nightly"] {
                assert!(accepts_version(&installed, &stable, channel));
                assert!(source_channels(channel).contains(&"stable"));
                assert!(!accepts_version(&stable, &installed, channel));
            }
        }
        let next_beta = Version::parse("0.28.1-beta.1").unwrap();
        assert!(accepts_version(&stable, &next_beta, "beta"));
        assert!(!accepts_version(&stable, &next_beta, "stable"));
    }
}
