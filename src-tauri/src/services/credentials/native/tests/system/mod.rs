//! Explicit hosted-Windows acceptance of the real OS binding lifecycle.
//! No desktop, HTTP/proxy runner, production identity or user configuration.
use super::super::{
    bindings, AppResult, Connection, Database, Owner, Platform, Service, Stamp, Uuid,
};
use super::call;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

mod fixture;

fn scope(_: &Connection) -> AppResult<Stamp> {
    Ok(Stamp::capture(b"isolated-native-binding-acceptance"))
}
fn digest(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

#[derive(Serialize, Deserialize)]
struct Manifest {
    database: std::path::PathBuf,
    service: String,
    host: String,
    proxy: String,
    host_hash: String,
    current_item: String,
    retired_items: Vec<String>,
}

#[test]
#[ignore = "explicit isolated real-OS binding acceptance on Windows"]
fn immutable_bindings_survive_restart_and_cleanup_preserves_other_services() {
    assert_eq!(
        std::env::var("TUNNELDE_TEST_APP_KEYRING").as_deref(),
        Ok("1")
    );
    let directory = fixture::Directory::new();
    let store = fixture::Store::new();
    let neighbor = fixture::Store::new();
    let path = directory.0.join("bindings.db");
    let host = Uuid::new_v4().to_string();
    let proxy = Uuid::new_v4().to_string();
    let host_owner = Owner::host(&host).unwrap();
    let proxy_owner = Owner::proxy(&proxy).unwrap();
    let old_host = Uuid::new_v4().to_string();
    let old_proxy = Uuid::new_v4().to_string();
    let host_secret = Uuid::new_v4().to_string();
    store.write(&host, &old_host).unwrap();
    store.write(&format!("proxy:{proxy}"), &old_proxy).unwrap();
    let current_item;
    {
        let db = fixture::upgrade(&path, &host, &proxy);
        let run = Uuid::new_v4();
        let service = Service::new(&db, &store, run).unwrap();
        let request = service
            .capture(host_owner.clone(), || Ok(()), scope)
            .unwrap();
        assert!(call(|job| service.read(&request, job)).unwrap().as_deref() == Some(&old_host));
        call(|job| service.save(&request, "first-owned-value", job)).unwrap();
        assert!(call(|job| service.read(&request, job)).is_err());
        let request = service
            .capture(host_owner.clone(), || Ok(()), scope)
            .unwrap();
        call(|job| service.save(&request, &host_secret, job)).unwrap();
        current_item = db
            .with(|conn| {
                Ok(bindings::capture(conn, &host_owner)?
                    .physical()
                    .unwrap()
                    .key())
            })
            .unwrap();
        assert_ne!(current_item, host);
        let request = service
            .capture(proxy_owner.clone(), || Ok(()), scope)
            .unwrap();
        assert!(call(|job| service.read(&request, job)).unwrap().as_deref() == Some(&old_proxy));
        call(|job| service.save(&request, "proxy-owned-value", job)).unwrap();
        let request = service
            .capture(proxy_owner.clone(), || Ok(()), scope)
            .unwrap();
        call(|job| service.forget(&request, job)).unwrap();
        // Leave an unpublished OS write under its original durable intent.
        // Startup must retire this exact item instead of replaying the save.
        let intent = service
            .transaction(|conn| {
                let binding = bindings::capture(conn, &host_owner)?;
                bindings::begin(conn, &binding, &scope(conn)?.0, run)
            })
            .unwrap();
        store
            .write(&intent.physical().key(), "orphan-owned-value")
            .unwrap();
    } // Close the parent DB before the child acquires exclusive ownership.
    let keys = store.keys();
    for key in &keys {
        neighbor.write(key, "neighbor-owned-value").unwrap();
    }
    let retired_items = keys
        .iter()
        .filter(|key| key.as_str() != current_item.as_str())
        .cloned()
        .collect();
    let manifest = Manifest {
        database: path.clone(),
        service: store.service.clone(),
        host,
        proxy,
        host_hash: digest(&host_secret),
        current_item,
        retired_items,
    };
    let manifest_path = directory.0.join("manifest.json");
    std::fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
    fixture::child(&manifest_path, &directory.0.join("child.log"));
    assert!(store.read(&manifest.current_item).unwrap().as_deref() == Some(&host_secret));
    for key in &manifest.retired_items {
        assert!(store.read(key).unwrap().is_none());
    }
    for key in &keys {
        assert!(neighbor.read(key).unwrap().as_deref() == Some("neighbor-owned-value"));
    }
    // Reopen again after the child; tombstones and the surviving binding persist.
    let db = Database::open(&path).unwrap();
    let service = Service::new(&db, &store, Uuid::new_v4()).unwrap();
    let request = service.capture(host_owner, || Ok(()), scope).unwrap();
    assert!(call(|job| service.read(&request, job)).unwrap().as_deref() == Some(&host_secret));
    let request = service.capture(proxy_owner, || Ok(()), scope).unwrap();
    assert!(call(|job| service.read(&request, job)).unwrap().is_none());
    drop(db);
    store.assert_empty();
    neighbor.assert_empty();
}

#[test]
#[ignore = "child of the explicit real-OS binding fixture"]
fn isolated_binding_reader_child() {
    assert_eq!(
        std::env::var("TUNNELDE_TEST_APP_KEYRING").as_deref(),
        Ok("1")
    );
    let path =
        std::path::PathBuf::from(std::env::var_os("TUNNELDE_TEST_BINDING_MANIFEST").unwrap());
    let manifest: Manifest = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    let suffix = manifest
        .service
        .strip_prefix("qa.tunnelde-bindings.")
        .unwrap();
    assert!(Uuid::parse_str(suffix).is_ok());
    assert_eq!(
        manifest.database,
        path.parent().unwrap().join("bindings.db")
    );
    let store = crate::vault::Vault::new(&manifest.service).unwrap();
    let db = Database::open(&manifest.database).unwrap();
    let service = Service::new(&db, &store, Uuid::new_v4()).unwrap();
    while service.recover_startup_page().unwrap() != 0 {}
    let request = service
        .capture(Owner::host(&manifest.host).unwrap(), || Ok(()), scope)
        .unwrap();
    assert!(
        digest(&call(|job| service.read(&request, job)).unwrap().unwrap()) == manifest.host_hash
    );
    let request = service
        .capture(Owner::proxy(&manifest.proxy).unwrap(), || Ok(()), scope)
        .unwrap();
    assert!(call(|job| service.read(&request, job)).unwrap().is_none());
    for key in &manifest.retired_items {
        assert!(store.load(key).unwrap().is_some());
    }
    let mut drained = false;
    for _ in 0..16 {
        if !call(|job| service.retire_one(job)).unwrap() {
            drained = true;
            break;
        }
    }
    assert!(drained, "bounded fixture cleanup did not finish");
    assert!(digest(&store.load(&manifest.current_item).unwrap().unwrap()) == manifest.host_hash);
    for key in &manifest.retired_items {
        assert!(store.load(key).unwrap().is_none());
    }
}
