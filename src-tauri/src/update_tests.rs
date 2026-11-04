use super::channels::source_channels;
use super::feeds::{github_channel_feed, GitHubRelease, ReleaseAsset};
use super::*;

fn version(value: &str) -> Version {
    Version::parse(value).unwrap()
}

#[test]
fn stable_and_beta_channels_use_semver_without_implicit_downgrades() {
    for (current, candidate, channel, expected) in [
        ("0.26.1", "0.26.2-beta.2.1", "stable", false),
        ("0.26.1", "0.26.2-beta.2.1", "beta", true),
        ("0.26.2-beta.2.1", "0.26.2", "stable", true),
        ("0.26.2-beta.2.1", "0.26.2", "beta", true),
        ("0.26.2-beta.2.1", "0.26.1", "stable", false),
        ("0.26.2", "0.26.2-beta.3.1", "beta", false),
        ("0.26.2", "0.26.3-beta.4.1", "beta", true),
        ("0.26.3-beta.9.1", "0.26.3-beta.10.1", "beta", true),
        ("0.26.3-beta.10.1", "0.26.3-beta.9.1", "beta", false),
        ("0.26.3", "0.26.4-beta.1", "beta", true),
        ("0.26.3-beta.99.1", "0.26.4-beta.1", "beta", true),
        ("0.26.3-beta.2.1", "0.26.3-beta.3", "beta", true),
        ("0.26.4-beta.9", "0.26.4-beta.10", "beta", true),
        ("0.26.4-beta.11", "0.26.4-beta12", "beta", true),
        ("0.26.4-beta09", "0.26.4-beta10", "beta", true),
        ("0.26.4-beta11", "0.26.4-beta12", "beta", true),
        ("0.26.4-beta12", "0.26.4-beta11", "beta", false),
        ("0.26.4-beta12", "0.26.4", "stable", true),
        ("0.26.4-beta99", "0.26.5-beta01", "beta", true),
        (
            "0.26.4-beta12",
            "0.26.4-beta12.d.1.gabcdef012345",
            "beta",
            false,
        ),
        (
            "0.26.4-beta12",
            "0.26.4-beta12.d.1.gabcdef012345",
            "nightly",
            true,
        ),
        (
            "0.26.4-beta12.d.1.gabcdef012345",
            "0.26.4-beta13",
            "nightly",
            true,
        ),
        ("0.26.4-beta.1", "0.26.4", "stable", true),
        ("0.26.1", "0.27.0-alpha.1", "beta", false),
        ("0.26.1", "0.26.2-beta.1.d.2.gabcdef012345", "beta", false),
        (
            "0.26.2-beta.1",
            "0.26.2-beta.1.d.2.gabcdef012345",
            "nightly",
            true,
        ),
        (
            "0.26.2-beta.1.d.2.gabcdef012345",
            "0.26.2-beta.2",
            "nightly",
            true,
        ),
        (
            "0.26.2-beta.1.d.2.gabcdef012345",
            "0.26.2-beta.1",
            "beta",
            false,
        ),
        ("0.26.2", "0.26.2", "stable", false),
        ("0.26.1", "0.26.2-alpha.1.d.9.gabcdef012345", "beta", false),
        (
            "0.26.1",
            "0.26.2-alpha.1.d.9.gabcdef012345",
            "nightly",
            true,
        ),
        (
            "0.26.2-alpha.1.d.9.gabcdef012345",
            "0.26.2-alpha.1.d.10.gabcdef012345",
            "nightly",
            true,
        ),
        (
            "0.26.2-alpha.1.d.999.gabcdef012345",
            "0.26.2-alpha.1.d.1000.gabcdef012345",
            "nightly",
            true,
        ),
        (
            "0.26.2-alpha.1.d.10.gabcdef012345",
            "0.26.2-beta.1",
            "nightly",
            true,
        ),
        (
            "0.26.2-beta.1",
            "0.26.2-alpha.1.d.20.gabcdef012345",
            "nightly",
            false,
        ),
        (
            "0.26.2-alpha.1.d.10.gabcdef012345",
            "0.26.2",
            "stable",
            true,
        ),
        (
            "0.26.2",
            "0.26.1-alpha.1.d.1000.gabcdef012345",
            "nightly",
            false,
        ),
    ] {
        assert_eq!(
            accepts_version(&version(current), &version(candidate), channel),
            expected,
            "{current} -> {candidate} ({channel})"
        );
    }
}

fn release(tag: &str, prerelease: bool, draft: bool, manifest: bool) -> GitHubRelease {
    GitHubRelease {
        body: Some("## Fixes\n\n- Reconnect terminals.".into()),
        tag_name: tag.into(),
        prerelease,
        draft,
        assets: if manifest {
            vec![ReleaseAsset {
                name: "latest.json".into(),
            }]
        } else {
            vec![]
        },
    }
}

#[test]
fn beta_discovery_chooses_newest_eligible_published_package_not_list_order() {
    let mut releases = vec![
        release("v0.26.2-beta.9.1", true, false, true),
        release("v0.26.1", false, false, true),
        release("v0.26.2-beta.10.1", true, false, true),
        release("v0.99.0-beta.1.1", true, true, true),
        release("v0.98.0-beta.1.1", true, false, false),
        release("v0.97.0-alpha.1", true, false, true),
        release("v0.96.0", true, false, true),
        release("v0.95.0-beta.1.1", false, false, true),
    ];
    let feed = github_channel_feed(&releases, "beta").unwrap();
    assert!(feed
        .notes
        .as_deref()
        .unwrap()
        .contains("Reconnect terminals"));
    assert_eq!(feed.version, Some(version("0.26.2-beta.10.1")));
    assert!(feed
        .url
        .as_str()
        .ends_with("/v0.26.2-beta.10.1/latest.json"));
    releases.push(release("v0.26.2", false, false, true));
    assert_eq!(
        github_channel_feed(&releases, "beta").unwrap().version,
        Some(version("0.26.2"))
    );
    releases.push(release("v0.26.3-beta.1", true, false, true));
    assert_eq!(
        github_channel_feed(&releases, "beta").unwrap().version,
        Some(version("0.26.3-beta.1"))
    );
    assert!(github_channel_feed(&[], "beta").is_err());
}

#[test]
fn compatibility_bridge_connects_legacy_clients_to_compact_beta_channels() {
    let releases = vec![
        release("v0.28.0-beta13", true, false, true),
        release("v0.28.0-beta.9", true, false, true),
        release("v0.28.0-beta.12", true, false, true),
        release("v0.28.0-beta.11", true, false, true),
    ];
    // The installed legacy parser can discover the bridge even with newer compact tags present.
    let legacy = releases
        .iter()
        .filter_map(|release| Version::parse(&release.tag_name[1..]).ok())
        .filter(|version| version.pre.as_str().starts_with("beta."))
        .max()
        .unwrap();
    assert_eq!(legacy, version("0.28.0-beta.12"));
    assert_eq!(
        github_channel_feed(&releases, "beta").unwrap().version,
        Some(version("0.28.0-beta13"))
    );
    assert!(accepts_version(&legacy, &version("0.28.0-beta13"), "beta"));
    for invalid in [
        "beta00",
        "beta1",
        "beta001",
        "beta100",
        "betamax",
        "beta13.d.2.gabcdef1",
    ] {
        assert!(!channels::channel_accepts(
            &version(&format!("0.28.0-{invalid}")),
            "beta"
        ));
    }
}

#[test]
fn custom_sources_require_https_and_a_single_path_placeholder() {
    for (url, valid) in [
        ("https://updates.example.com/{channel}/latest.json", true),
        ("https://updates.example.com/tunnelde-{channel}.json", true),
        ("http://updates.example.com/{channel}.json", false),
        ("file:///tmp/{channel}.json", false),
        ("https://user:secret@example.com/{channel}.json", false),
        ("https://user@example.com/{channel}.json", false),
        ("https://example.com/latest.json", false),
        ("https://example.com/{channel}/{channel}.json", false),
        ("https://example.com/{channel}.json?token=secret", false),
        ("https://example.com/{channel}.json#fragment", false),
        ("https://{channel}.example.com/stable.json", false),
        (
            "https://{channel}.example.com/tunnelde-update-channel/latest.json",
            false,
        ),
        ("https://example.com/{channel}/{target}.json", false),
        (" https://example.com/{channel}.json", false),
        ("https://example.com/{channel}.json\n", false),
    ] {
        let settings = Settings {
            update_source: "custom".into(),
            update_source_url: url.into(),
            ..Settings::default()
        };
        assert_eq!(validate_preferences(&settings).is_ok(), valid, "{url}");
    }
}

#[test]
fn automatic_checks_respect_enabled_frequency_and_clock_changes() {
    let day = 86_400_000;
    let mut settings = Settings {
        last_update_check: Some(day),
        ..Settings::default()
    };
    assert!(!auto_check_due(&settings, day + 1, true));
    assert!(auto_check_due(&settings, 2 * day, true));
    assert!(auto_check_due(&settings, day - 1, false));
    settings.update_check_interval = "weekly".into();
    assert!(!auto_check_due(&settings, 2 * day, true));
    assert!(auto_check_due(&settings, 8 * day, false));
    settings.update_check_interval = "startup".into();
    assert!(auto_check_due(&settings, day + 1, true));
    assert!(!auto_check_due(&settings, 100 * day, false));
    settings.last_update_check = None;
    settings.update_check_interval = "daily".into();
    assert!(auto_check_due(&settings, 1, false));
    settings.auto_check_updates = false;
    assert!(!auto_check_due(&settings, 100 * day, true));
}

#[test]
fn changing_source_or_channel_invalidates_previous_selection_and_release_link() {
    let mut settings = Settings::default();
    let mut snapshot = UpdateState::new("0.26.1".into(), &settings);
    snapshot.download_url =
        Some("https://github.com/TunneldeDev/Tunnelde/releases/tag/v0.26.2".into());
    assert!(snapshot.matches(&settings));
    assert!(release_page(&settings, &snapshot).ends_with("/v0.26.2"));
    settings.update_channel = "beta".into();
    assert!(!snapshot.matches(&settings));
    assert!(release_page(&settings, &snapshot).ends_with("/releases"));
    settings.update_channel = snapshot.channel.clone();
    settings.update_source = "custom".into();
    assert!(!snapshot.matches(&settings));
    settings.update_source = snapshot.source.clone();
    settings.update_source_url = "https://mirror.example.com/{channel}.json".into();
    assert!(!snapshot.matches(&settings));
}

#[test]
fn checks_and_installation_share_an_exclusive_cancellation_safe_guard() {
    let service = UpdateService::new("0.26.1".into());
    let guard = service.acquire().unwrap();
    assert!(service.acquire().is_none());
    drop(guard);
    assert!(service.acquire().is_some());
}

#[test]
fn installation_locks_channel_and_source_but_allows_other_preferences() {
    let previous = Settings::default();
    let mut snapshot = UpdateState::new("0.26.1".into(), &previous);
    snapshot.phase = Phase::Downloading;
    let mut next = previous.clone();
    next.update_channel = "beta".into();
    assert!(validate_settings_change(&previous, &next, &snapshot).is_err());
    next = previous.clone();
    next.update_source = "custom".into();
    assert!(validate_settings_change(&previous, &next, &snapshot).is_err());
    next = previous.clone();
    next.update_source_url = "https://example.com/{channel}.json".into();
    assert!(validate_settings_change(&previous, &next, &snapshot).is_err());
    next = previous.clone();
    next.theme = "dark".into();
    assert!(validate_settings_change(&previous, &next, &snapshot).is_ok());
    snapshot.phase = Phase::Error;
    next.update_channel = "beta".into();
    assert!(validate_settings_change(&previous, &next, &snapshot).is_ok());
}

#[test]
fn nightly_discovery_includes_beta_and_stable_but_beta_excludes_nightly() {
    let releases = vec![
        release("v0.27.0-alpha.1.d.10.gabcdef012345", true, false, true),
        release("v0.26.2-beta.1", true, false, true),
        release("v0.26.2-beta.1.d.2.gabcdef012345", true, false, true),
        release("v0.26.1", false, false, true),
        release("v0.99.0-alpha.1.d.1.gabcdef012345", true, true, true),
        release("v0.98.0-alpha.1.d.1.gabcdef012345", true, false, false),
    ];
    assert_eq!(
        github_channel_feed(&releases, "nightly").unwrap().version,
        Some(version("0.27.0-alpha.1.d.10.gabcdef012345"))
    );
    assert_eq!(
        github_channel_feed(&releases, "beta").unwrap().version,
        Some(version("0.26.2-beta.1"))
    );
    assert_eq!(
        github_channel_feed(&releases, "stable").unwrap().version,
        Some(version("0.26.1"))
    );
    assert_eq!(source_channels("nightly"), &["stable", "beta", "nightly"]);
    assert_eq!(source_channels("beta"), &["stable", "beta"]);
    assert_eq!(source_channels("stable"), &["stable"]);
}
