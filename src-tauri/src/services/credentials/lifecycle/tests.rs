use super::*;
use crate::{
    db::{self, Database},
    models::HostInput,
    settings::Settings,
};

fn draft(address: &str) -> crate::models::HostDraft {
    serde_json::from_value::<HostInput>(serde_json::json!({"name":"QA","host":address}))
        .unwrap()
        .validate()
        .unwrap()
}

#[test]
fn cosmetic_host_edits_keep_identity_but_destination_roundtrip_does_not() {
    Database::in_memory()
        .unwrap()
        .with(|conn| {
            let host = db::hosts::create_host(conn, &draft("original"))?;
            let first = host_incarnation(conn, &host.id)?;
            let mut cosmetic = draft("original");
            cosmetic.name = "Renamed".into();
            db::hosts::update_host(conn, &host.id, &cosmetic)?;
            assert_eq!(host_incarnation(conn, &host.id)?, first);
            db::hosts::update_host(conn, &host.id, &draft("replacement"))?;
            db::hosts::update_host(conn, &host.id, &draft("original"))?;
            assert_ne!(host_incarnation(conn, &host.id)?, first);
            assert!(bindings::capture(conn, &Owner::host(&host.id)?)?
                .physical()
                .is_none());
            Ok(())
        })
        .unwrap();
}

#[test]
fn nested_host_metadata_failure_rolls_back_fields_even_if_outer_caller_catches_error() {
    Database::in_memory().unwrap().with(|conn| {
        let host=db::hosts::create_host(conn,&draft("original"))?;
        let original=host_incarnation(conn,&host.id)?;
        conn.execute_batch("CREATE TRIGGER refuse_binding BEFORE UPDATE ON credential_bindings BEGIN SELECT RAISE(ABORT,'controlled metadata failure'); END;")?;
        let tx=conn.unchecked_transaction()?;
        assert!(db::hosts::update_host(&tx,&host.id,&draft("replacement")).is_err());
        assert_eq!(db::hosts::find_host(&tx,&host.id)?.host,"original");
        tx.execute("INSERT INTO settings VALUES('unrelated','committed',0)",[])?;
        tx.commit()?;
        assert_eq!(host_incarnation(conn,&host.id)?,original);
        assert_eq!(db::hosts::find_host(conn,&host.id)?.host,"original");
        Ok(())
    }).unwrap();
}

#[test]
fn host_delete_is_atomic_with_its_tombstone_and_auth_change_rotates_identity() {
    Database::in_memory().unwrap().with(|conn| {
        let host=db::hosts::create_host(conn,&draft("original"))?;
        let original=host_incarnation(conn,&host.id)?;
        db::hosts::set_key_auth(conn,&host.id,"qa-key")?;
        assert_ne!(host_incarnation(conn,&host.id)?,original);
        conn.execute_batch("CREATE TRIGGER refuse_binding BEFORE UPDATE ON credential_bindings BEGIN SELECT RAISE(ABORT,'controlled metadata failure'); END;")?;
        assert!(db::hosts::delete_host(conn,&host.id).is_err());
        assert!(db::hosts::find_host(conn,&host.id).is_ok());
        conn.execute_batch("DROP TRIGGER refuse_binding")?;
        db::hosts::delete_host(conn,&host.id)?;
        assert!(bindings::capture(conn,&Owner::host(&host.id)?)?.physical().is_none());
        Ok(())
    }).unwrap();
}

fn network() -> NetworkSettings {
    serde_json::from_value(serde_json::json!({"profiles":[{"id":"office","name":"Office","protocol":"http","host":"127.0.0.1","port":7890,"username":"qa"}],"defaultProxy":"office","features":{}})).unwrap()
}

fn network_incarnation(conn: &Connection) -> AppResult<Vec<u8>> {
    selection_authority(
        conn,
        &db::settings::load_checked(conn)?.network,
        "ssh",
        None,
    )
}

#[test]
fn proxy_rename_and_reorder_keep_authority_but_remove_readd_rotates_it() {
    Database::in_memory()
        .unwrap()
        .with(|conn| {
            let mut settings = Settings {
                network: network(),
                ..Settings::default()
            };
            db::settings::save(conn, &settings)?;
            let incarnation = network_incarnation(conn)?;
            let proxy = proxy_incarnation(conn, "office")?;
            settings.network.profiles[0].name = "Renamed".into();
            settings.theme = "dark".into();
            db::settings::save(conn, &settings)?;
            assert_eq!(network_incarnation(conn)?, incarnation);
            assert_eq!(proxy_incarnation(conn, "office")?, proxy);
            db::settings::save(conn, &Settings::default())?;
            db::settings::save(conn, &settings)?;
            assert_ne!(network_incarnation(conn)?, incarnation);
            assert_ne!(proxy_incarnation(conn, "office")?, proxy);
            assert!(bindings::capture(conn, &Owner::proxy("office")?)?
                .physical()
                .is_none());
            Ok(())
        })
        .unwrap();
}

#[test]
fn proxy_metadata_failure_rolls_back_the_entire_settings_and_incarnation_change() {
    Database::in_memory().unwrap().with(|conn| {
        let settings=Settings {network:network(),..Settings::default()};
        db::settings::save(conn,&settings)?;
        let identity=network_incarnation(conn)?;
        conn.execute_batch("CREATE TRIGGER refuse_binding BEFORE UPDATE ON credential_bindings BEGIN SELECT RAISE(ABORT,'controlled metadata failure'); END;")?;
        assert!(db::settings::save(conn,&Settings::default()).is_err());
        assert_eq!(db::settings::load_checked(conn)?.network.profiles.len(),1);
        assert_eq!(network_incarnation(conn)?,identity);
        Ok(())
    }).unwrap();
}

#[test]
fn route_changes_are_atomic_and_reject_identical_field_aba_without_forgetting_credential_source() {
    Database::in_memory()
        .unwrap()
        .with(|conn| {
            let host = db::hosts::create_host(conn, &draft("original"))?;
            let owner = Owner::host(&host.id)?;
            let original = bindings::capture(conn, &owner)?;
            let route = crate::network::ConnectionRoute {
                proxy: "direct".into(),
                jump_hosts: vec![],
            };
            db::atomic(conn, |conn| {
                crate::network::save_route_at(conn, &host.id, &route)
            })?;
            db::atomic(conn, |conn| {
                crate::network::save_route_at(conn, &host.id, &Default::default())
            })?;
            let changed = bindings::capture(conn, &owner)?;
            assert_ne!(changed.incarnation(), original.incarnation());
            assert!(changed.physical() == original.physical());
            let same = changed.incarnation();
            db::atomic(conn, |conn| {
                crate::network::save_route_at(conn, &host.id, &Default::default())
            })?;
            assert_eq!(host_incarnation(conn, &host.id)?, same);
            Ok(())
        })
        .unwrap();
}

#[test]
fn malformed_incarnation_cannot_be_used_as_a_new_authorization_baseline() {
    Database::in_memory()
        .unwrap()
        .with(|conn| {
            use sha2::{Digest, Sha256};
            let key = format!(
                "credentials.network.selector.{:x}",
                Sha256::digest(b"feature:ssh")
            );
            conn.execute("INSERT INTO settings VALUES(?1,'invalid',0)", [key])?;
            assert!(network_incarnation(conn).is_err());
            Ok(())
        })
        .unwrap();
}

#[test]
fn scoped_proxy_authority_ignores_unrelated_edits_but_rejects_default_and_profile_aba() {
    Database::in_memory()
        .unwrap()
        .with(|conn| {
            let mut settings = Settings {
                network: network(),
                ..Settings::default()
            };
            db::settings::save(conn, &settings)?;
            let capture = |conn: &Connection, settings: &Settings, value| {
                selection_authority(conn, &settings.network, "ssh", value)
            };
            let inherited = capture(conn, &settings, None)?;
            let explicit = capture(conn, &settings, Some("office"))?;
            settings
                .network
                .features
                .insert("updates".into(), "direct".into());
            let mut other = settings.network.profiles[0].clone();
            other.id = "other".into();
            settings.network.profiles.push(other);
            db::settings::save(conn, &settings)?;
            assert_eq!(capture(conn, &settings, None)?, inherited);
            assert_eq!(capture(conn, &settings, Some("office"))?, explicit);
            settings.network.default_proxy = "direct".into();
            db::settings::save(conn, &settings)?;
            settings.network.default_proxy = "office".into();
            db::settings::save(conn, &settings)?;
            assert_ne!(capture(conn, &settings, None)?, inherited);
            assert_eq!(capture(conn, &settings, Some("office"))?, explicit);
            settings.network.profiles[0].host = "elsewhere".into();
            db::settings::save(conn, &settings)?;
            settings.network.profiles[0].host = "127.0.0.1".into();
            db::settings::save(conn, &settings)?;
            assert_ne!(capture(conn, &settings, Some("office"))?, explicit);
            Ok(())
        })
        .unwrap();
}
