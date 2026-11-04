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
