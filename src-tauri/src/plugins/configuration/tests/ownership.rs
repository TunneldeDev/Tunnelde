use crate::{
    db::Database,
    plugins::{security, PluginsManager},
};
use std::{
    sync::{mpsc, Arc},
    time::Duration,
};

#[test]
fn installed_schema_is_fenced_by_identity_and_package_replacement_until_transaction_finishes() {
    let root = std::env::temp_dir().join(format!("tunnelde-config-owner-{}", uuid::Uuid::new_v4()));
    let package = root.join("owner");
    std::fs::create_dir_all(&package).unwrap();
    std::fs::write(package.join("index.mjs"), "export {};\n").unwrap();
    std::fs::write(package.join("tunnelde-plugin.json"),serde_json::to_vec(&serde_json::json!({
        "id":"owner","name":"Owner","version":"1.0.0","apiVersion":1,"runtime":"node","main":"index.mjs","permissions":[],
        "configuration":{"version":1,"groups":[{"id":"general","title":"General"}],"fields":[{"id":"flag","group":"general","title":"Flag","schema":{"type":"boolean"},"default":false}]}
    })).unwrap()).unwrap();
    let manager = Arc::new(PluginsManager::load(root.clone()));
    let fingerprint = security::fingerprint(&package).unwrap();
    assert!(manager
        .with_configuration::<()>("other", &fingerprint, |_| panic!(
            "foreign configuration accessed"
        ))
        .is_err());
    assert!(manager
        .with_configuration::<()>("owner", "old", |_| panic!("changed package accessed"))
        .is_err());
    let (entered_tx, entered_rx) = mpsc::channel();
    let (finish_tx, finish_rx) = mpsc::channel();
    let writer = {
        let manager = manager.clone();
        let fingerprint = fingerprint.clone();
        std::thread::spawn(move || {
            manager.with_configuration::<()>("owner", &fingerprint, |_| {
                entered_tx.send(()).unwrap();
                finish_rx.recv().unwrap();
                Ok(())
            })
        })
    };
    entered_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    let (replaced_tx, replaced_rx) = mpsc::channel();
    let replacer = {
        let manager = manager.clone();
        std::thread::spawn(move || {
            let mut snapshots = manager.snapshots.write().unwrap();
            snapshots.get_mut("owner").unwrap().fingerprint = "replacement".into();
            replaced_tx.send(()).unwrap();
        })
    };
    assert!(replaced_rx.recv_timeout(Duration::from_millis(20)).is_err());
    finish_tx.send(()).unwrap();
    writer.join().unwrap().unwrap();
    replacer.join().unwrap();
    assert!(manager
        .with_configuration::<()>("owner", &fingerprint, |_| panic!("stale schema committed"))
        .is_err());
    drop(manager);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn owned_configuration_without_global_permissions_still_rejects_retired_runtime() {
    let db = Database::in_memory().unwrap();
    let security = security::PluginSecurity::default();
    let fingerprint = "a".repeat(64);
    security
        .set_permissions(&db, "owner", fingerprint.clone(), &[], Some(vec![]))
        .unwrap();
    let lease = security.lease("owner", fingerprint, vec![]).unwrap();
    security
        .with_authorized::<()>(&lease, &[], || Ok(()))
        .unwrap();
    security.invalidate_runtime("owner");
    assert!(security
        .with_authorized::<()>(&lease, &[], || panic!("retired configuration write"))
        .is_err());
}
