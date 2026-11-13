use super::*;

fn row() -> durable::DurableTransfer {
    serde_json::from_value(serde_json::json!({
        "id": uuid::Uuid::new_v4().to_string(), "pluginId": "original-plugin",
        "direction":"transfer", "name":"file", "fromSession":"offline-source",
        "fromHostId":"source-host", "fromAddress":"user@source:22", "fromPath":"/source/file",
        "toSession":"destination", "toHostId":"target-host", "toAddress":"user@target:22", "toPath":"/target/file",
        "removeSource":false, "overwrite":false, "transferred":0, "total":0,
        "status":"cleanupPending", "error":null, "updatedAt":1
    })).unwrap()
}

fn target(row: &durable::DurableTransfer) -> native_save::runtime::TaskEndpoint {
    native_save::runtime::TaskEndpoint {
        path: row.to_path.clone(),
        remote: Some(crate::ssh::session::SessionIdentity {
            host_id: row.to_host_id.clone().unwrap(),
            address: row.to_address.clone().unwrap(),
            server_key: "original-target-key".into(),
        }),
    }
}

#[test]
fn cleanup_keeps_original_plugin_attribution_without_creating_a_runtime_lease() {
    let registry = TransferRegistry::default();
    let row = row();
    registry
        .register(&row.id, Arc::new(AtomicBool::new(false)), None)
        .unwrap();
    assert!(registry.install_cleanup(&row, target(&row)).is_err());
    registry.begin_cleanup(&row.id).unwrap();
    registry.install_cleanup(&row, target(&row)).unwrap();
    let state = registry.inner.lock().unwrap();
    let active = &state.active[&row.id];
    assert_eq!(active.event.plugin_id.as_deref(), Some("original-plugin"));
    assert!(active.owner.is_none() && active.lease.is_none());
    let cleanup = active.cleanup.as_ref().unwrap();
    assert!(cleanup.projection == Projection::from(&row));
    assert_eq!(
        cleanup.destination.remote.as_ref().unwrap().host_id,
        "target-host"
    );
}

#[test]
fn cleanup_rejects_changed_plugin_endpoint_or_pending_original_and_cannot_be_retargeted() {
    let registry = TransferRegistry::default();
    let row = row();
    let owner = TransferOwner {
        plugin_id: "original-plugin".into(),
        generation: 7,
        cancelled: tokio::sync::watch::channel(false).0,
    };
    registry
        .register(&row.id, Arc::new(AtomicBool::new(true)), Some(owner))
        .unwrap();
    let receipt = registry.observation(&row.id).unwrap().begin().unwrap();
    assert!(registry.begin_cleanup(&row.id).is_err());
    assert!(registry.install_cleanup(&row, target(&row)).is_err());
    receipt.acknowledge();
    registry.begin_cleanup(&row.id).unwrap();
    let mut changed = row.clone();
    changed.plugin_id = Some("other-plugin".into());
    assert!(registry.install_cleanup(&changed, target(&row)).is_err());
    let mut changed = target(&row);
    changed.remote.as_mut().unwrap().server_key = "other-key".into();
    registry.install_cleanup(&row, target(&row)).unwrap();
    assert!(registry.install_cleanup(&row, changed).is_err());
    let mut changed = row.clone();
    changed.from_path = "/other-source".into();
    assert!(registry.install_cleanup(&changed, target(&row)).is_err());
    let (old_instance, cleanup) = registry.cleanup_task(&row.id).unwrap().unwrap();
    registry.release(&row.id);
    registry
        .register(&row.id, Arc::new(AtomicBool::new(false)), None)
        .unwrap();
    assert!(registry.cleanup_task(&row.id).unwrap().is_none());
    assert!(registry.install_cleanup(&row, target(&row)).is_err());
    registry.begin_cleanup(&row.id).unwrap();
    registry.install_cleanup(&row, target(&row)).unwrap();
    let (instance, restored) = registry.cleanup_task(&row.id).unwrap().unwrap();
    assert_ne!(instance, old_instance);
    assert!(restored == cleanup);
}

#[test]
fn mutable_progress_and_status_do_not_change_cleanup_intent_but_paths_and_ownership_do() {
    let original = row();
    let expected = Projection::from(&original);
    let mut progress = original.clone();
    progress.transferred = 8192;
    progress.status = "cancelled".into();
    progress.updated_at += 1;
    assert!(Projection::from(&progress) == expected);
    for variant in 0..7 {
        let mut changed = original.clone();
        match variant {
            0 => changed.plugin_id = None,
            1 => changed.from_path = "/other".into(),
            2 => changed.to_host_id = Some("other".into()),
            3 => changed.to_address = Some("other@host:22".into()),
            4 => changed.to_session = None,
            5 => changed.remove_source = true,
            6 => changed.overwrite = true,
            _ => unreachable!(),
        }
        assert!(Projection::from(&changed) != expected);
    }
}
