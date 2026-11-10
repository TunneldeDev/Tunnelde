use super::*;
use serde_json::json;

fn manifest(range: Option<&str>) -> PluginManifest {
    serde_json::from_value(json!({
        "id":"sample", "name":"Sample", "version":"1.0.0", "apiVersion":1,
        "engines": range.map(|range| json!({"node":range})).unwrap_or(json!({})),
    }))
    .unwrap()
}

fn runtime(source: &str, version: &str) -> NodeRuntimeInfo {
    NodeRuntimeInfo {
        path: Some(
            std::env::current_exe()
                .unwrap()
                .to_string_lossy()
                .into_owned(),
        ),
        version: Some(version.into()),
        source: Some(source.into()),
        compatible: true,
        minimum_major: 22,
        issue: None,
    }
}

#[test]
fn system_runtime_sources_each_require_consent_and_cannot_borrow_later_consent() {
    for source in ["environment", "path", "registry", "shell"] {
        let mut config = PluginConfig::default();
        assert_eq!(
            PreparedNode::checked(&config, &manifest(None), runtime(source, "24.0.0"))
                .err()
                .unwrap()
                .to_string(),
            "node.required"
        );
        config.node_system_allowed = true;
        let ready =
            PreparedNode::checked(&config, &manifest(None), runtime(source, "24.0.0")).unwrap();
        config.node_system_allowed = false;
        assert_eq!(
            ready.check_policy(&config).unwrap_err().to_string(),
            "node.required"
        );
    }
}

#[test]
fn managed_and_explicit_runtime_choices_do_not_require_system_runtime_consent() {
    for source in ["managed", "explicit"] {
        let config = PluginConfig {
            node_path: (source == "explicit").then(|| {
                std::env::current_exe()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned()
            }),
            ..PluginConfig::default()
        };
        let ready =
            PreparedNode::checked(&config, &manifest(None), runtime(source, "24.0.0")).unwrap();
        assert!(ready.check_policy(&config).is_ok());
    }
}

#[test]
fn node_versions_use_ordinary_runtime_semver_including_prerelease_rules() {
    for (range, version, allowed) in [
        (">=22", "24.0.0", true),
        (">=22", "v24.0.0", true),
        ("^22", "24.0.0", false),
        (">=22", "24.0.0-beta.1", false),
        (">=24.0.0-beta.1", "24.0.0-beta.2", true),
        (">=22", "invalid", false),
    ] {
        let result = PreparedNode::checked(
            &PluginConfig::default(),
            &manifest(Some(range)),
            runtime("managed", version),
        );
        assert_eq!(result.is_ok(), allowed, "{range} / {version}");
        if !allowed {
            assert_eq!(result.err().unwrap().to_string(), "node.incompatible");
        }
    }
}

#[test]
fn incomplete_or_incompatible_resolution_cannot_become_a_prepared_runtime() {
    let mut value = runtime("managed", "24.0.0");
    value.compatible = false;
    assert!(PreparedNode::checked(&PluginConfig::default(), &manifest(None), value).is_err());
    let mut value = runtime("managed", "24.0.0");
    value.path = None;
    assert!(PreparedNode::checked(&PluginConfig::default(), &manifest(None), value).is_err());
    let mut value = runtime("managed", "24.0.0");
    value.path = Some("relative/node".into());
    assert!(PreparedNode::checked(&PluginConfig::default(), &manifest(None), value).is_err());
}

#[test]
fn resolution_source_must_agree_with_the_authorized_runtime_selection() {
    let default = PluginConfig::default();
    for source in [None, Some("unknown"), Some("explicit")] {
        let mut value = runtime("managed", "24.0.0");
        value.source = source.map(str::to_owned);
        assert!(PreparedNode::checked(&default, &manifest(None), value).is_err());
    }
    let explicit = PluginConfig {
        node_path: Some("selected-node".into()),
        node_system_allowed: true,
        ..PluginConfig::default()
    };
    for source in ["managed", "environment", "path", "registry", "shell"] {
        assert!(
            PreparedNode::checked(&explicit, &manifest(None), runtime(source, "24.0.0")).is_err()
        );
    }
}

#[test]
fn runtime_choice_is_revalidated_against_authoritative_settings_before_spawn() {
    let db = Database::in_memory().unwrap();
    let mut config = PluginConfig::default();
    let ready =
        PreparedNode::checked(&config, &manifest(None), runtime("managed", "24.0.0")).unwrap();
    // Unrelated source edits do not invalidate an already prepared runtime.
    config.sources[0].enabled = false;
    db.with(|connection| config::save(connection, &config))
        .unwrap();
    ready.revalidate(&db).unwrap();
    config.node_path = Some("different-choice".into());
    db.with(|connection| config::save(connection, &config))
        .unwrap();
    assert_eq!(
        ready.revalidate(&db).unwrap_err().to_string(),
        "pluginSecurity.changed"
    );
}

#[test]
fn consent_revocation_is_checked_in_the_database_even_before_runtime_source_registration() {
    let db = Database::in_memory().unwrap();
    let mut config = PluginConfig {
        node_system_allowed: true,
        ..PluginConfig::default()
    };
    db.with(|connection| config::save(connection, &config))
        .unwrap();
    let ready = PreparedNode::checked(&config, &manifest(None), runtime("path", "24.0.0")).unwrap();
    ready.revalidate(&db).unwrap();
    config.node_system_allowed = false;
    db.with(|connection| config::save(connection, &config))
        .unwrap();
    assert_eq!(
        ready.revalidate(&db).unwrap_err().to_string(),
        "node.required"
    );
}
