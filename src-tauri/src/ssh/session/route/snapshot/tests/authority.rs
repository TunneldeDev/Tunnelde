use super::*;
use crate::network::{proxy::Selected, NetworkSettings, ProxyProfile};

fn network() -> NetworkSettings {
    NetworkSettings {
        profiles: vec![ProxyProfile {
            id: "selected".into(),
            name: "Display".into(),
            protocol: "http".into(),
            host: "127.0.0.1".into(),
            port: 7890,
            username: "user".into(),
        }],
        default_proxy: "selected".into(),
        ..Default::default()
    }
}
fn snapshot(conn: &rusqlite::Connection, settings: &crate::settings::Settings) -> Snapshot {
    let target = host(conn, "authority");
    let route = ConnectionRoute::default();
    let vault = crate::vault::Vault::new("dev.tunnelde.qa.route-authority").unwrap();
    Snapshot {
        nodes: capture_nodes(conn, &target, &route).unwrap(),
        route,
        transport: TcpRoute::capture_with(
            &vault,
            &NetworkSettings::default(),
            &target.host,
            target.port,
            "direct",
        )
        .unwrap(),
        proxy: Selected::capture(&settings.network, "ssh", None).unwrap(),
    }
}

#[test]
fn final_admission_rejects_persisted_proxy_edits_even_before_memory_publication() {
    Database::in_memory()
        .unwrap()
        .with(|conn| {
            let memory = crate::settings::Settings {
                network: network(),
                ..Default::default()
            };
            db::settings::save(conn, &memory)?;
            let expected = snapshot(conn, &memory);
            expected.verify_saved(conn)?;
            for field in 0..5 {
                let mut durable = memory.clone();
                let profile = &mut durable.network.profiles[0];
                match field {
                    0 => profile.host = "replacement".into(),
                    1 => profile.port += 1,
                    2 => profile.protocol = "socks5".into(),
                    3 => profile.username = "replacement".into(),
                    _ => {
                        profile.id = "replacement".into();
                        durable.network.default_proxy = "replacement".into();
                    }
                }
                // The in-memory copy deliberately remains unchanged, matching the
                // actual durable-commit / AppState publication interval.
                db::settings::save(conn, &durable)?;
                assert_eq!(
                    expected.verify_saved(conn).unwrap_err().to_string(),
                    "ssh.connectionChanged"
                );
                assert_eq!(memory.network.profiles[0].host, "127.0.0.1");
                db::settings::save(conn, &memory)?;
                expected.verify_saved(conn)?;
            }
            Ok(())
        })
        .unwrap();
}

#[test]
fn final_admission_checks_effective_default_and_feature_selection_and_missing_profiles() {
    Database::in_memory()
        .unwrap()
        .with(|conn| {
            let memory = crate::settings::Settings {
                network: network(),
                ..Default::default()
            };
            db::settings::save(conn, &memory)?;
            let expected = snapshot(conn, &memory);
            for selection in ["system", "direct", "missing"] {
                for feature in [true, false] {
                    let mut durable = memory.clone();
                    if feature {
                        durable
                            .network
                            .features
                            .insert("ssh".into(), selection.into());
                    } else {
                        durable.network.default_proxy = selection.into();
                    }
                    db::settings::save(conn, &durable)?;
                    assert!(expected.verify_saved(conn).is_err());
                }
            }
            let mut durable = memory.clone();
            durable.network.profiles.clear();
            db::settings::save(conn, &durable)?;
            assert!(expected.verify_saved(conn).is_err());
            Ok(())
        })
        .unwrap();
}

#[test]
fn cosmetics_unrelated_profiles_and_nonssh_features_do_not_revoke_final_admission() {
    Database::in_memory()
        .unwrap()
        .with(|conn| {
            let mut settings = crate::settings::Settings {
                network: network(),
                ..Default::default()
            };
            db::settings::save(conn, &settings)?;
            let expected = snapshot(conn, &settings);
            settings.network.profiles[0].name = "Renamed".into();
            let mut unrelated = settings.network.profiles[0].clone();
            unrelated.id = "unrelated".into();
            unrelated.host = "elsewhere".into();
            settings.network.profiles.push(unrelated);
            settings
                .network
                .features
                .insert("updates".into(), "direct".into());
            db::settings::save(conn, &settings)?;
            expected.verify_saved(conn)?;
            // Explicit host overrides continue to dominate changed defaults/features.
            let mut explicit = expected.clone();
            explicit.route.proxy = "selected".into();
            save_route(conn, &explicit.target().id, &explicit.route);
            settings.network.default_proxy = "direct".into();
            settings
                .network
                .features
                .insert("ssh".into(), "system".into());
            db::settings::save(conn, &settings)?;
            explicit.verify_saved(conn)
        })
        .unwrap();
}

#[test]
fn corrupt_durable_settings_never_reauthorize_a_default_route() {
    Database::in_memory().unwrap().with(|conn| {
        let settings = crate::settings::Settings::default();
        let expected = snapshot(conn, &settings);
        expected.verify_saved(conn)?;
        conn.execute("INSERT OR REPLACE INTO settings(key,value,updated_at) VALUES('app','broken json',0)", [])?;
        assert_eq!(expected.verify_saved(conn).unwrap_err().to_string(), "ssh.connectionChanged");
        // Preserve startup's separate migration fallback behavior.
        assert_eq!(db::settings::load(conn)?.update_channel, "stable");
        assert!(db::settings::load_checked(conn).is_err());
        Ok(())
    }).unwrap();
}

#[test]
fn prompt_review_includes_selected_profile_identity_even_for_the_same_transport() {
    Database::in_memory()
        .unwrap()
        .with(|conn| {
            let settings = crate::settings::Settings {
                network: network(),
                ..Default::default()
            };
            let expected = snapshot(conn, &settings);
            let original = expected.revision();
            let mut renamed = settings.network.clone();
            renamed.profiles[0].name = "Cosmetic".into();
            let mut changed = expected.clone();
            changed.proxy = Selected::capture(&renamed, "ssh", None)?;
            assert_eq!(original, changed.revision());
            renamed.profiles[0].id = "other".into();
            renamed.default_proxy = "other".into();
            changed.proxy = Selected::capture(&renamed, "ssh", None)?;
            assert_ne!(original, changed.revision());
            Ok(())
        })
        .unwrap();
}

#[test]
fn observed_key_approval_updates_only_original_endpoint_aliases_without_os_reads() {
    Database::in_memory()
        .unwrap()
        .with(|conn| {
            let settings = crate::settings::Settings::default();
            let mut expected = snapshot(conn, &settings);
            let target = expected.target().clone();
            let alias = db::hosts::create_host(
                conn,
                &HostInput {
                    name: "Alias".into(),
                    host: target.host.clone(),
                    port: Some(target.port),
                    username: Some(target.username.clone()),
                    ..serde_json::from_value(serde_json::json!({
                        "name":"unused", "host":"unused", "username":"unused"
                    }))
                    .unwrap()
                }
                .validate()?,
            )?;
            let unrelated = host(conn, "unrelated");
            expected.route.jump_hosts = vec![alias.id.clone(), unrelated.id.clone()];
            save_route(conn, &target.id, &expected.route);
            expected.nodes = capture_nodes(conn, &target, &expected.route)?;
            let original = expected.revision();
            let info = HostKeyInfo {
                host_id: target.id.clone(),
                fingerprint: "SHA256:approved".into(),
                algorithm: "ssh-ed25519".into(),
                status: HostKeyStatus::Unknown,
                known_fingerprint: None,
                connection_time_ms: None,
            };
            expected.approve_at(conn, &info, || Ok(()))?;
            expected.verify_saved(conn)?;
            assert_ne!(original, expected.revision());
            assert_eq!(expected.nodes[0].key.as_deref(), Some("SHA256:approved"));
            assert_eq!(expected.nodes[1].key, None);
            assert_eq!(expected.nodes[2].key.as_deref(), Some("SHA256:approved"));
            assert!(db::known_hosts::find(conn, &unrelated.host, unrelated.port as i64)?.is_none());
            Ok(())
        })
        .unwrap();
}

#[test]
fn cancelled_or_stale_observed_key_approval_never_changes_native_trust() {
    Database::in_memory()
        .unwrap()
        .with(|conn| {
            let settings = crate::settings::Settings::default();
            let mut expected = snapshot(conn, &settings);
            let target = expected.target().clone();
            let info = HostKeyInfo {
                host_id: target.id.clone(),
                fingerprint: "SHA256:rejected".into(),
                algorithm: "ssh-ed25519".into(),
                status: HostKeyStatus::Unknown,
                known_fingerprint: None,
                connection_time_ms: None,
            };
            assert_eq!(
                expected
                    .approve_at(conn, &info, || Err(AppError::validation(
                        "plugin.runners.browserExpired"
                    )))
                    .unwrap_err()
                    .to_string(),
                "plugin.runners.browserExpired"
            );
            assert!(db::known_hosts::find(conn, &target.host, target.port as i64)?.is_none());
            let mut settings = settings;
            settings.network.default_proxy = "direct".into();
            db::settings::save(conn, &settings)?;
            assert_eq!(
                expected
                    .approve_at(conn, &info, || panic!("stale operation admitted"))
                    .unwrap_err()
                    .to_string(),
                "ssh.connectionChanged"
            );
            assert!(db::known_hosts::find(conn, &target.host, target.port as i64)?.is_none());
            assert!(expected.nodes.iter().all(|node| node.key.is_none()));
            Ok(())
        })
        .unwrap();
}
