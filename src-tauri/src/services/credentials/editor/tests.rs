use super::*;
mod migration;
use crate::{
    db::{self, Database},
    models::HostInput,
    network::ConnectionRoute,
};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};

type Callback = Box<dyn Fn() -> AppResult<()> + Send + Sync>;
#[derive(Default)]
struct Platform {
    values: Mutex<BTreeMap<String, String>>,
    writing: Mutex<Option<Callback>>,
    deleting: Mutex<Option<Callback>>,
}
impl native::Platform for Platform {
    fn read(&self, item: &str) -> AppResult<Option<String>> {
        Ok(self.values.lock().unwrap().get(item).cloned())
    }
    fn write(&self, item: &str, secret: &str) -> AppResult<()> {
        if let Some(callback) = self.writing.lock().unwrap().as_ref() {
            callback()?;
        }
        self.values
            .lock()
            .unwrap()
            .insert(item.into(), secret.into());
        Ok(())
    }
    fn delete(&self, item: &str) -> AppResult<()> {
        if let Some(callback) = self.deleting.lock().unwrap().as_ref() {
            callback()?;
        }
        self.values.lock().unwrap().remove(item);
        Ok(())
    }
}

fn proxy_fixture(db: &Database) -> (crate::settings::Settings, crate::network::ProxyProfile) {
    let profile=serde_json::from_value(serde_json::json!({"id":"qa","name":"QA","protocol":"http","host":"localhost","port":7890,"username":""})).unwrap();
    let mut settings = crate::settings::Settings::default();
    settings.network.profiles.push(profile);
    db.with(|conn| db::settings::save(conn, &settings)).unwrap();
    let profile = settings.network.profiles[0].clone();
    (settings, profile)
}

#[test]
fn proxy_recreated_before_admission_cannot_receive_the_old_editors_password() {
    let db = Database::in_memory().unwrap();
    let (settings, profile) = proxy_fixture(&db);
    let authority = db
        .with(|conn| authority::ProxyAuthority::capture(conn, &profile))
        .unwrap();
    db.with(|conn| {
        db::settings::save(conn, &crate::settings::Settings::default())?;
        db::settings::save(conn, &settings)
    })
    .unwrap();
    let platform = Platform::default();
    assert!(apply_proxy(
        &db,
        &platform,
        uuid::Uuid::new_v4(),
        &authority,
        &save("stale"),
        || panic!("stale request admitted")
    )
    .is_err());
    assert!(platform.values.lock().unwrap().is_empty());
}

#[test]
fn proxy_cleanup_uses_the_retired_item_even_if_a_replacement_is_saved_during_delete() {
    let db = Arc::new(Database::in_memory().unwrap());
    let (settings, profile) = proxy_fixture(&db);
    let platform = Arc::new(Platform::default());
    let run = uuid::Uuid::new_v4();
    // Drain any legacy retirement before arranging the immutable-item race.
    let service = native::Service::new(&db, &*platform, run).unwrap();
    let retire = || {
        let (job, _guard) =
            crate::services::operations::Cancellation::for_test("credentials.cancelled");
        service.retire_one(&job)
    };
    while retire().unwrap() {}
    let capture = || {
        db.with(|conn| authority::ProxyAuthority::capture(conn, &profile))
            .unwrap()
    };
    apply_proxy(&db, &*platform, run, &capture(), &save("original"), || {
        Ok(())
    })
    .unwrap();
    db.with(|conn| db::settings::save(conn, &crate::settings::Settings::default()))
        .unwrap();
    let changed = db.clone();
    let weak = Arc::downgrade(&platform);
    let copy = profile.clone();
    *platform.deleting.lock().unwrap() = Some(Box::new(move || {
        let authority = changed.with(|conn| {
            db::settings::save(conn, &settings)?;
            authority::ProxyAuthority::capture(conn, &copy)
        })?;
        apply_proxy(
            &changed,
            &*weak.upgrade().unwrap(),
            run,
            &authority,
            &save("replacement"),
            || Ok(()),
        )
    }));
    assert!(retire().unwrap());
    *platform.deleting.lock().unwrap() = None;
    while retire().unwrap() {}
    let current = capture();
    let request = service
        .capture(
            bindings::Owner::proxy(&profile.id).unwrap(),
            || Ok(()),
            |conn| current.check(conn),
        )
        .unwrap();
    assert_eq!(
        service.read_after_admission(&request).unwrap().as_deref(),
        Some("replacement")
    );
    assert_eq!(platform.values.lock().unwrap().len(), 1);
}
fn draft(address: &str) -> crate::models::HostDraft {
    serde_json::from_value::<HostInput>(serde_json::json!({"name":"QA","host":address}))
        .unwrap()
        .validate()
        .unwrap()
}
fn create(db: &Database) -> (crate::models::Host, authority::HostAuthority) {
    db.with(|conn| {
        persist_host(
            conn,
            None,
            &draft("original"),
            &ConnectionRoute::default(),
            || Ok(()),
        )
    })
    .unwrap()
}
fn save(value: &str) -> CredentialChange {
    CredentialChange::Save {
        password: value.into(),
    }
}

#[test]
fn invalid_route_and_cancelled_admission_leave_no_host_or_binding() {
    let db = Database::in_memory().unwrap();
    db.with(|conn| {
        let route = ConnectionRoute {
            proxy: "missing".into(),
            ..Default::default()
        };
        assert!(persist_host(conn, None, &draft("original"), &route, || Ok(())).is_err());
        assert!(
            persist_host(conn, None, &draft("original"), &Default::default(), || Err(
                crate::error::AppError::validation("credentials.cancelled")
            ))
            .is_err()
        );
        for table in ["hosts", "credential_bindings", "credential_cleanup"] {
            assert_eq!(
                conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r
                    .get::<_, i64>(0))?,
                0
            );
        }
        Ok(())
    })
    .unwrap();
}

#[test]
fn failed_os_save_keeps_committed_host_id_and_retry_updates_that_host() {
    let db = Database::in_memory().unwrap();
    let (host, authority) = create(&db);
    let platform = Platform::default();
    *platform.writing.lock().unwrap() = Some(Box::new(|| {
        Err(crate::error::AppError::validation("controlled.osDenied"))
    }));
    let run = uuid::Uuid::new_v4();
    assert_eq!(
        apply_host(&db, &platform, run, &authority, &save("secret"))
            .unwrap_err()
            .to_string(),
        "controlled.osDenied"
    );
    let (retry, new_authority) = db
        .with(|conn| {
            persist_host(
                conn,
                Some(&host.id),
                &draft("original"),
                &Default::default(),
                || Ok(()),
            )
        })
        .unwrap();
    assert_eq!(retry.id, host.id);
    *platform.writing.lock().unwrap() = None;
    apply_host(&db, &platform, run, &new_authority, &save("confirmed")).unwrap();
    db.with(|conn| {
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM hosts", [], |r| r.get::<_, i64>(0))?,
            1
        );
        Ok(())
    })
    .unwrap();
}

#[test]
fn a_slow_os_write_does_not_hold_the_database_and_cannot_publish_after_host_edit() {
    let db = Arc::new(Database::in_memory().unwrap());
    let (host, authority) = create(&db);
    let changed = db.clone();
    let id = host.id.clone();
    let platform = Platform::default();
    *platform.writing.lock().unwrap() = Some(Box::new(move || {
        assert!(changed
            .try_with(|conn| {
                db::hosts::update_host(conn, &id, &draft("replacement"))?;
                Ok(())
            })?
            .is_some());
        Ok(())
    }));
    assert!(apply_host(
        &db,
        &platform,
        uuid::Uuid::new_v4(),
        &authority,
        &save("old-request")
    )
    .is_err());
    db.with(|conn| {
        assert_eq!(db::hosts::find_host(conn, &host.id)?.host, "replacement");
        assert!(bindings::capture(conn, &bindings::Owner::host(&host.id)?)?
            .physical()
            .is_none());
        Ok(())
    })
    .unwrap();
}

#[test]
fn an_original_editor_cannot_refresh_its_binding_after_a_newer_password_save() {
    let db = Database::in_memory().unwrap();
    let (host, authority) = create(&db);
    let platform = Platform::default();
    let run = uuid::Uuid::new_v4();
    apply_host(&db, &platform, run, &authority, &save("first")).unwrap();
    assert_eq!(
        apply_host(&db, &platform, run, &authority, &save("stale"))
            .unwrap_err()
            .to_string(),
        "credentials.changed"
    );
    let current = db
        .with(|conn| authority::HostAuthority::capture(conn, &host.id))
        .unwrap();
    let service = native::Service::new(&db, &platform, run).unwrap();
    let request = service
        .capture(
            bindings::Owner::host(&host.id).unwrap(),
            || Ok(()),
            |conn| current.check(conn),
        )
        .unwrap();
    assert_eq!(
        service.read_after_admission(&request).unwrap().as_deref(),
        Some("first")
    );
}

#[test]
fn trust_roundtrip_revokes_editor_authority_while_unrelated_network_edits_do_not() {
    let db = Database::in_memory().unwrap();
    let (host, _) = create(&db);
    db.with(|conn| db::known_hosts::upsert(conn, &host.host, 22, "ssh-ed25519", "SHA256:original"))
        .unwrap();
    let authority = db
        .with(|conn| authority::HostAuthority::capture(conn, &host.id))
        .unwrap();
    db.with(|conn| {
        let mut settings = db::settings::load_checked(conn)?;
        settings
            .network
            .features
            .insert("updates".into(), "direct".into());
        db::settings::save(conn, &settings)?;
        authority.check(conn)?;
        db::known_hosts::upsert(conn, &host.host, 22, "ssh-ed25519", "SHA256:changed")?;
        db::known_hosts::upsert(conn, &host.host, 22, "ssh-ed25519", "SHA256:original")?;
        assert!(authority.check(conn).is_err());
        Ok(())
    })
    .unwrap();
}

#[test]
fn profile_authority_rejects_replacement_but_allows_unrelated_selectors() {
    let db = Database::in_memory().unwrap();
    db.with(|conn| {
        let mut settings=crate::settings::Settings::default();
        let profile:crate::network::ProxyProfile=serde_json::from_value(serde_json::json!({"id":"qa","name":"QA","protocol":"http","host":"localhost","port":7890,"username":""})).unwrap();
        settings.network.profiles.push(profile.clone());
        db::settings::save(conn,&settings)?;
        let original=authority::proxy_stamp(conn,&profile)?;
        settings.network.features.insert("updates".into(),"direct".into());
        db::settings::save(conn,&settings)?;
        assert!(authority::proxy_stamp(conn,&profile)?==original);
        settings.network.profiles.clear();
        db::settings::save(conn,&settings)?;
        settings.network.profiles.push(profile.clone());
        db::settings::save(conn,&settings)?;
        assert!(authority::proxy_stamp(conn,&profile)?!=original);
        Ok(())
    }).unwrap();
}
