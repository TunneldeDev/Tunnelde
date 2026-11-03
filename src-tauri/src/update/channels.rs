use semver::Version;

pub(super) fn accepts_version(current: &Version, candidate: &Version, channel: &str) -> bool {
    candidate > current && channel_accepts(candidate, channel)
}

pub(super) fn channel_accepts(candidate: &Version, channel: &str) -> bool {
    let pre = candidate.pre.as_str();
    candidate.pre.is_empty()
        || (["beta", "nightly"].contains(&channel)
            && pre.starts_with("beta.")
            && !pre.contains(".d."))
        || (channel == "nightly"
            && (pre.starts_with("alpha.") || (pre.starts_with("beta.") && pre.contains(".d."))))
}

pub(super) fn source_channels(channel: &str) -> &'static [&'static str] {
    match channel {
        "nightly" => &["stable", "beta", "nightly"],
        "beta" => &["stable", "beta"],
        _ => &["stable"],
    }
}
