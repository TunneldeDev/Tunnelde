use super::*;
fn fixture() -> (Ownership, String, String, String, Lease) {
    let mut owner = Ownership::default();
    let main = owner.register(MAIN).unwrap();
    let target = owner.register("target").unwrap();
    let other = owner.register("other").unwrap();
    for (w, d) in [(MAIN, &main), ("target", &target), ("other", &other)] {
        owner.ready(w, d).unwrap();
    }
    let id = format!("files:{}", uuid::Uuid::new_v4());
    let lease = owner
        .bind_file_page(
            MAIN,
            &main,
            &id,
            Sources {
                local: true,
                remote: HashMap::new(),
            },
            true,
        )
        .unwrap();
    (owner, main, target, other, lease)
}
#[test]
fn only_main_explicit_resource_registration_admits_a_file_page() {
    let (mut owner, main, target, _, lease) = fixture();
    let id = format!(
        "sftp:{}:copy:{}",
        uuid::Uuid::new_v4(),
        uuid::Uuid::new_v4()
    );
    owner.add_panel(MAIN, &main, &id).unwrap();
    assert!(!owner.transferable(&id));
    assert!(owner
        .bind_file_page(
            MAIN,
            &main,
            &id,
            Sources {
                local: true,
                remote: HashMap::new()
            },
            true
        )
        .is_err());
    assert!(owner
        .bind_file_page(
            "target",
            &target,
            &lease.panel_id,
            Sources {
                local: true,
                remote: HashMap::new()
            },
            true
        )
        .is_err());
    assert!(owner.transferable(&lease.panel_id));
    assert_eq!(
        owner
            .bind_file_page(
                MAIN,
                &main,
                &lease.panel_id,
                Sources {
                    local: true,
                    remote: HashMap::new()
                },
                true
            )
            .unwrap(),
        lease
    );
    for id in [
        "files:any",
        "terminal:123",
        "sftp:../../file",
        "sftp:abc:copy:other",
    ] {
        assert!(!valid_id(id));
    }
}
#[test]
fn staged_reads_require_exact_destination_and_mutations_wait_for_commit() {
    let (mut owner, main, target, other, lease) = fixture();
    let binding = owner.file_pages.bindings[&lease.panel_id].clone();
    let now = Instant::now();
    let offer = owner
        .prepare(MAIN, &main, &lease, "target", Value::Null, now)
        .unwrap();
    let staged = Target::Staged {
        id: offer.id.clone(),
    };
    assert!(owner
        .file_page_target("target", &target, &staged, &binding, false)
        .is_ok());
    assert!(owner
        .file_page_target("other", &other, &staged, &binding, false)
        .is_err());
    assert!(owner
        .file_page_target("target", &target, &staged, &binding, true)
        .is_err());
    assert!(owner
        .begin_file_page_effect(
            MAIN,
            &main,
            &Target::Owned {
                lease: lease.clone()
            },
            &binding
        )
        .is_err());
    owner
        .acknowledge("target", &target, &offer.id, now)
        .unwrap();
    let next = owner.commit(MAIN, &main, &offer.id, now).unwrap();
    assert!(owner
        .file_page_target("target", &target, &staged, &binding, false)
        .is_err());
    assert!(owner
        .file_page_target(MAIN, &main, &Target::Owned { lease }, &binding, false)
        .is_err());
    assert!(owner
        .file_page_target(
            "target",
            &target,
            &Target::Owned { lease: next },
            &binding,
            true
        )
        .is_ok());
}
#[test]
fn exact_effect_fence_survives_coordinator_reload_until_actual_worker_settlement() {
    let (mut owner, main, _, _, lease) = fixture();
    let binding = owner.file_pages.bindings[&lease.panel_id].clone();
    let (_, id) = owner
        .begin_file_page_effect(
            MAIN,
            &main,
            &Target::Owned {
                lease: lease.clone(),
            },
            &binding,
        )
        .unwrap();
    assert!(owner
        .prepare(MAIN, &main, &lease, "target", Value::Null, Instant::now())
        .is_err());
    assert!(owner.remove_panel(MAIN, &main, &lease.panel_id).is_err());
    let replacement = owner.register(MAIN).unwrap();
    assert!(owner
        .remove_panel(MAIN, &replacement, &lease.panel_id)
        .is_err());
    assert!(!owner.file_page_registered(&lease.panel_id));
    owner.finish_native_action(&lease.panel_id, &id);
    owner
        .remove_panel(MAIN, &replacement, &lease.panel_id)
        .unwrap();
    assert!(!owner.file_pages.bindings.contains_key(&lease.panel_id));
}
#[test]
fn changed_source_set_and_coordinator_document_never_revive_an_old_binding() {
    let (mut owner, main, _, _, lease) = fixture();
    let original = owner.file_pages.bindings[&lease.panel_id].clone();
    let session = uuid::Uuid::new_v4().to_string();
    let sources = Sources {
        local: true,
        remote: HashMap::from([(
            session,
            SessionIdentity {
                host_id: "host".into(),
                address: "qa@host:22".into(),
                server_key: "key".into(),
            },
        )]),
    };
    owner
        .bind_file_page(MAIN, &main, &lease.panel_id, sources.clone(), true)
        .unwrap();
    assert!(owner
        .file_page_target(
            MAIN,
            &main,
            &Target::Owned {
                lease: lease.clone()
            },
            &original,
            false
        )
        .is_err());
    let before_reload = owner.file_pages.bindings[&lease.panel_id].clone();
    let next = owner.register(MAIN).unwrap();
    owner
        .bind_file_page(MAIN, &next, &lease.panel_id, sources, true)
        .unwrap();
    assert!(owner
        .file_page_target(MAIN, &next, &Target::Owned { lease }, &before_reload, false)
        .is_err());
    let descriptors = owner.file_page_descriptors();
    assert_eq!(
        descriptors[0].as_object().unwrap().len(),
        2,
        "metadata must not publish source/session/server-key authority"
    );
}
#[test]
fn unsupported_providers_block_outgoing_moves_but_never_the_return_to_main() {
    let (mut owner, main, target, _, lease) = fixture();
    let now = Instant::now();
    let offer = owner
        .prepare(MAIN, &main, &lease, "target", Value::Null, now)
        .unwrap();
    owner
        .acknowledge("target", &target, &offer.id, now)
        .unwrap();
    let next = owner.commit(MAIN, &main, &offer.id, now).unwrap();
    owner
        .bind_file_page(
            MAIN,
            &main,
            &lease.panel_id,
            Sources {
                local: true,
                remote: HashMap::new(),
            },
            false,
        )
        .unwrap();
    assert!(owner
        .prepare("target", &target, &next, "other", Value::Null, now)
        .is_err());
    assert!(owner
        .prepare("target", &target, &next, MAIN, Value::Null, now)
        .is_ok());
}
#[test]
fn closed_grammar_rejects_arbitrary_ipc_caller_selectors_and_unbounded_paths() {
    assert!(
        serde_json::from_value::<Request>(json!({"action":"invoke","method":"ssh_connect"}))
            .is_err()
    );
    assert!(serde_json::from_value::<Request>(
        json!({"action":"unbind","panelId":"files:x","windowId":"main"})
    )
    .is_err());
    assert!(
        serde_json::from_value::<Source>(json!({"kind":"local","sessionId":"forged"})).is_err()
    );
    assert!(!Operation::Mkdir {
        source: Source::Local {},
        path: "a\0b".into()
    }
    .valid());
    assert!(!Operation::Rename {
        source: Source::Local {},
        from: "a".repeat(32769),
        to: "b".into(),
        overwrite: false
    }
    .valid());
    assert!(!Operation::Home {
        source: Source::Remote {
            session_id: "arbitrary".into()
        }
    }
    .valid());
}

#[test]
fn transfer_validation_checks_both_sources_and_paths_without_session_fallback() {
    let valid = json!({"operation":"transfer","fromSource":{"kind":"local"},"fromPath":"/local/file",
        "toSource":{"kind":"remote","sessionId":uuid::Uuid::new_v4().to_string()},
        "toPath":"/remote/file","removeSource":false,"overwrite":false});
    let operation: Operation = serde_json::from_value(valid.clone()).unwrap();
    assert!(operation.valid());
    assert!(operation.mutation());
    assert_eq!(operation.sources().len(), 2);
    for (field, value) in [
        ("toPath", json!("bad\0path")),
        ("fromPath", json!("")),
        ("toSource", json!({"kind":"remote","sessionId":"invalid"})),
    ] {
        let mut invalid = valid.clone();
        invalid[field] = value;
        assert!(!serde_json::from_value::<Operation>(invalid)
            .unwrap()
            .valid());
    }
    let mut unknown = valid;
    unknown["windowId"] = json!("main");
    assert!(serde_json::from_value::<Operation>(unknown).is_err());
}
