use super::*;

#[test]
fn projection_is_closed_and_never_contains_document_capsules_or_models() {
    let mut state = Ownership::default();
    let document = state.register(MAIN).unwrap();
    let satellite = state.register("satellite").unwrap();
    state.ready(MAIN, &document).unwrap();
    state.ready("satellite", &satellite).unwrap();
    let lease = state.add_panel(MAIN, &document, "tasks").unwrap();
    let publisher = state.begin_model(MAIN, &document, "tasks").unwrap();
    state
        .publish_model(
            MAIN,
            &document,
            "tasks",
            &publisher,
            1,
            json!({"secret": "model-sentinel"}),
        )
        .unwrap();
    state
        .checkpoint(
            MAIN,
            &document,
            &lease,
            1,
            json!({"password": "draft-sentinel"}),
        )
        .unwrap();
    let projection = state.public_metadata();
    assert_eq!(
        projection
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect::<Vec<_>>(),
        ["panels", "windowId", "windows"]
    );
    assert_eq!(
        projection["panels"][0],
        json!({"panelId":"tasks","windowId":"main","generation":lease.generation,"transferable":true,"canMove":true})
    );
    for secret in [
        &document,
        &satellite,
        &publisher,
        "model-sentinel",
        "draft-sentinel",
    ] {
        assert!(!projection.to_string().contains(secret));
    }
    assert_eq!(projection["windows"][0]["panelIds"], json!(["tasks"]));
}

#[test]
fn revision_ignores_feature_progress_but_tracks_native_ownership_availability_and_reloads() {
    let public = PublicWindows::default();
    let mut state = Ownership::default();
    let document = state.register(MAIN).unwrap();
    state.ready(MAIN, &document).unwrap();
    let lease = state.add_panel(MAIN, &document, "tasks").unwrap();
    let first = public.update(state.public_metadata()).0;
    assert!(public.update(state.public_metadata()).1.is_none());
    let publisher = state.begin_model(MAIN, &document, "tasks").unwrap();
    state
        .publish_model(
            MAIN,
            &document,
            "tasks",
            &publisher,
            1,
            json!({"progress": 99}),
        )
        .unwrap();
    assert_eq!(public.update(state.public_metadata()).0, first);
    let interaction = state.begin_interaction(MAIN, &document, &lease).unwrap();
    let blocked = public.update(state.public_metadata()).0;
    assert_ne!(blocked["revision"], first["revision"]);
    assert_eq!(blocked["panels"][0]["canMove"], false);
    state
        .end_interaction(MAIN, &document, &lease, &interaction)
        .unwrap();
    assert_ne!(
        public.update(state.public_metadata()).0["revision"],
        blocked["revision"]
    );
    state.register(MAIN).unwrap();
    assert_ne!(
        public.update(state.public_metadata()).0["revision"],
        first["revision"]
    );
}

#[test]
fn close_never_targets_coordinator_unready_active_handoffs_or_consent() {
    let mut state = Ownership::default();
    let main = state.register(MAIN).unwrap();
    state.ready(MAIN, &main).unwrap();
    let sat = state.register("satellite").unwrap();
    assert!(state.public_close_target(MAIN).is_err());
    assert!(state.public_close_target("arbitrary").is_err());
    assert!(state.public_close_target("satellite").is_err());
    state.ready("satellite", &sat).unwrap();
    assert!(state.public_close_target("satellite").is_ok());
    let lease = state.add_panel(MAIN, &main, "tasks").unwrap();
    let now = std::time::Instant::now();
    let offer = state
        .prepare(MAIN, &main, &lease, "satellite", Value::Null, now)
        .unwrap();
    assert!(state.public_close_target("satellite").is_err());
    state
        .acknowledge("satellite", &sat, &offer.id, now)
        .unwrap();
    let lease = state.commit(MAIN, &main, &offer.id, now).unwrap();
    assert!(state.public_close_target("satellite").is_ok());
    let interaction = state.begin_interaction("satellite", &sat, &lease).unwrap();
    assert!(state.public_close_target("satellite").is_err());
    state
        .end_interaction("satellite", &sat, &lease, &interaction)
        .unwrap();
    assert!(state.public_close_target("satellite").is_ok());
    state.begin_close("satellite", &sat).unwrap();
    assert!(state.public_close_target("satellite").is_err());
}

#[test]
fn plugin_placeholder_cleanup_is_generation_scoped_and_has_no_authority_over_populated_windows() {
    let public = PublicWindows::default();
    let lease = |id: &str, generation| PluginLease {
        id: id.into(),
        fingerprint: "a".repeat(64),
        permissions: vec!["workspace.write".into()],
        generation,
    };
    {
        let mut created = public.created.lock().unwrap();
        created.insert("old".into(), lease("one", 1));
        created.insert("current".into(), lease("one", 2));
        created.insert("unrelated".into(), lease("two", 1));
    }
    assert_eq!(public.retire("one", 2), ["old"]);
    assert!(public.retire("one", 2).is_empty());
    assert_eq!(public.created.lock().unwrap().len(), 2);
    public.forget("unrelated");
    assert_eq!(public.retire("two", 2), Vec::<String>::new());
}

#[test]
fn cancellation_reaps_both_late_construction_and_sent_but_unconsumed_creation_results() {
    let mut before = CreationLifetime::default();
    assert!(before.cancel().is_none());
    assert!(!before.admit("late"));
    let mut during = CreationLifetime::default();
    assert!(during.admit("created"));
    assert_eq!(during.cancel().as_deref(), Some("created"));
    assert!(during.cancel().is_none());
    assert!(!during.admit("replacement"));
}

#[tokio::test]
async fn observation_subscription_precedes_inspection_and_cancellation_releases_its_receiver() {
    let public = PublicWindows::default();
    let mut changes = public.changed.subscribe();
    let metadata = json!({"windowId":"main","windows":[],"panels":[]});
    let first = public.update(metadata.clone()).0;
    changes.changed().await.unwrap();
    assert_eq!(
        *changes.borrow_and_update(),
        first["revision"].as_str().unwrap()
    );
    public.update(metadata);
    assert!(!changes.has_changed().unwrap());
    assert_eq!(public.changed.receiver_count(), 1);
    drop(changes);
    assert_eq!(public.changed.receiver_count(), 0);
    // No live receivers is not a reason to lose native revisions.
    let changed = public
        .update(json!({"windowId":"main","windows":[{"id":"pending"}],"panels":[]}))
        .0;
    assert_ne!(changed["revision"], first["revision"]);
    assert_eq!(
        *public.changed.subscribe().borrow(),
        changed["revision"].as_str().unwrap()
    );
}

#[test]
fn discovery_and_metadata_advertise_only_permission_checked_native_capabilities() {
    let discovery: Value =
        serde_json::from_str(include_str!("../../../plugins/extensions.json")).unwrap();
    let windows = &discovery["nativeWindows"];
    assert_eq!(windows["readPermission"], "workspace.read");
    assert_eq!(windows["writePermission"], "workspace.write");
    assert_eq!(windows["maximumWindows"], 16);
    assert_eq!(windows["placeholder"]["emptyTimeoutSeconds"], 20);
    assert_eq!(windows["eventPayload"], "revision-only-invalidation");
    for method in windows["methods"].as_array().unwrap() {
        assert!(crate::plugins::api::method_info(method.as_str().unwrap()).is_some());
    }
}

#[test]
fn dispatch_expiration_and_native_effect_fences_change_public_availability_without_feature_data() {
    use super::super::protocol::Command;
    use std::time::{Duration, Instant};
    let public = PublicWindows::default();
    let mut state = Ownership::default();
    let main = state.register(MAIN).unwrap();
    let satellite = state.register("satellite").unwrap();
    state.ready(MAIN, &main).unwrap();
    state.ready("satellite", &satellite).unwrap();
    let panel = state.add_panel(MAIN, &main, "connections").unwrap();
    let first = public.update(state.public_metadata()).0;
    let effect = state.begin_native_action(MAIN, &main, &panel).unwrap();
    let busy = public.update(state.public_metadata()).0;
    assert_ne!(busy["revision"], first["revision"]);
    assert_eq!(busy["panels"][0]["canMove"], false);
    state.finish_native_action("connections", &effect);
    assert_eq!(
        public.update(state.public_metadata()).0["panels"][0]["canMove"],
        true
    );
    let now = Instant::now();
    state
        .prepare(MAIN, &main, &panel, "satellite", Value::Null, now)
        .unwrap();
    let frozen = public.update(state.public_metadata()).0;
    assert_eq!(frozen["panels"][0]["canMove"], false);
    state
        .dispatch(
            MAIN,
            &main,
            Command::Snapshot {},
            now + Duration::from_secs(16),
        )
        .unwrap();
    let expired = public.update(state.public_metadata()).0;
    assert_ne!(expired["revision"], frozen["revision"]);
    assert_eq!(expired["panels"][0]["canMove"], true);
    // Expiring during a failed dispatch must be published too.
    state
        .prepare(MAIN, &main, &panel, "satellite", Value::Null, now)
        .unwrap();
    let frozen = public.update(state.public_metadata()).0;
    assert!(state
        .dispatch(
            MAIN,
            &main,
            Command::Staged {
                id: "missing".into()
            },
            now + Duration::from_secs(16)
        )
        .is_err());
    let expired = public.update(state.public_metadata()).0;
    assert_ne!(expired["revision"], frozen["revision"]);
    assert_eq!(expired["panels"][0]["canMove"], true);
}
