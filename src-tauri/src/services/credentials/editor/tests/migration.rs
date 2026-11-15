//! SQLite-only upgrade fixture, with a controlled platform boundary.
use super::*;

struct Fixture(std::path::PathBuf);
impl Drop for Fixture {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn pre_binding_database_keeps_legacy_host_and_proxy_secrets_until_explicitly_forgotten() {
    let fixture = Fixture(std::env::temp_dir().join(format!(
        "tunnelde-credential-upgrade-{}",
        uuid::Uuid::new_v4()
    )));
    std::fs::create_dir(&fixture.0).unwrap();
    let path = fixture.0.join("test.db");
    let conn = rusqlite::Connection::open(&path).unwrap();
    for sql in crate::db::migrations::MIGRATIONS.iter().take(5) {
        conn.execute_batch(sql).unwrap();
    }
    conn.pragma_update(None, "user_version", 5).unwrap();
    conn.execute("INSERT INTO hosts(id,name,host,created_at,updated_at) VALUES('legacy-host','Legacy','legacy.example',0,0)",[]).unwrap();
    let profile:crate::network::ProxyProfile=serde_json::from_value(serde_json::json!({"id":"legacy","name":"Legacy","protocol":"http","host":"localhost","port":7890,"username":"qa"})).unwrap();
    let mut settings = crate::settings::Settings::default();
    settings.network.profiles.push(profile.clone());
    conn.execute(
        "INSERT INTO settings VALUES('app',?1,0)",
        [serde_json::to_string(&settings).unwrap()],
    )
    .unwrap();
    drop(conn);
    let db = Database::open(&path).unwrap();
    let platform = Platform::default();
    let run = uuid::Uuid::new_v4();
    platform
        .values
        .lock()
        .unwrap()
        .insert("legacy-host".into(), "retained-host-secret".into());
    platform
        .values
        .lock()
        .unwrap()
        .insert("proxy:legacy".into(), "retained-proxy-secret".into());
    {
        let service = native::Service::new(&db, &platform, run).unwrap();
        let host = db
            .with(|conn| authority::HostAuthority::capture(conn, "legacy-host"))
            .unwrap();
        let proxy = db
            .with(|conn| authority::ProxyAuthority::capture(conn, &profile))
            .unwrap();
        let request = service
            .capture(
                bindings::Owner::host("legacy-host").unwrap(),
                || Ok(()),
                |conn| host.check(conn),
            )
            .unwrap();
        assert_eq!(
            service.read_after_admission(&request).unwrap().as_deref(),
            Some("retained-host-secret")
        );
        let request = service
            .capture(
                bindings::Owner::proxy("legacy").unwrap(),
                || Ok(()),
                |conn| proxy.check(conn),
            )
            .unwrap();
        assert_eq!(
            service.read_after_admission(&request).unwrap().as_deref(),
            Some("retained-proxy-secret")
        );
        apply_host(&db, &platform, run, &host, &CredentialChange::Forget).unwrap();
        apply_proxy(
            &db,
            &platform,
            run,
            &proxy,
            &CredentialChange::Forget,
            || Ok(()),
        )
        .unwrap();
    }
    drop(db);
    let restarted = Database::open(&path).unwrap();
    let host = restarted
        .with(|conn| authority::HostAuthority::capture(conn, "legacy-host"))
        .unwrap();
    let proxy = restarted
        .with(|conn| authority::ProxyAuthority::capture(conn, &profile))
        .unwrap();
    let service = native::Service::new(&restarted, &platform, uuid::Uuid::new_v4()).unwrap();
    let request = service
        .capture(
            bindings::Owner::host("legacy-host").unwrap(),
            || Ok(()),
            |conn| host.check(conn),
        )
        .unwrap();
    assert!(service.read_after_admission(&request).unwrap().is_none());
    let request = service
        .capture(
            bindings::Owner::proxy("legacy").unwrap(),
            || Ok(()),
            |conn| proxy.check(conn),
        )
        .unwrap();
    assert!(service.read_after_admission(&request).unwrap().is_none());
    // Tombstones survive even though deferred OS cleanup has not run yet.
    assert_eq!(platform.values.lock().unwrap().len(), 2);
    drop(restarted);
}
