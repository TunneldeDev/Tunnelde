use super::*;
use serde_json::json;
fn setup() -> (Ownership, String, Lease, Scope) {
    let mut owner = Ownership::default();
    let document = owner.register("main").unwrap();
    owner.ready("main", &document).unwrap();
    let lease = owner.add_panel("main", &document, "forwarding").unwrap();
    let interaction = owner.begin_interaction("main", &document, &lease).unwrap();
    let scope = Scope::new("main", &document, &lease, &interaction);
    (owner, document, lease, scope)
}
fn request(id: &str, scope: &Scope) -> Request {
    serde_json::from_value(json!({"operation":"test","id":"rule","revision":"one","interaction":scope.interaction,"review":{"hostId":"host","revision":"a".repeat(64)},"testId":id})).unwrap()
}
#[test]
fn early_cancel_is_sticky_and_rejected_start_never_leaks_a_native_fence() {
    let (mut owner, document, lease, scope) = setup();
    let id = uuid::Uuid::new_v4().to_string();
    owner.cancel_forwarding_test(&id, scope.clone()).unwrap();
    for _ in 0..2 {
        assert_eq!(
            owner
                .begin_forwarding("main", &document, &lease, &request(&id, &scope))
                .unwrap_err(),
            "ssh.testCancelled"
        );
        assert!(owner.panels["forwarding"].native_actions.is_empty());
    }
}
#[test]
fn cancellation_is_exact_cleanup_not_fresh_consent_or_another_windows_authority() {
    let (mut owner, document, lease, scope) = setup();
    let id = uuid::Uuid::new_v4().to_string();
    let action = owner
        .begin_forwarding("main", &document, &lease, &request(&id, &scope))
        .unwrap();
    let cancel = owner.forwarding_tests.receiver(&id, &action).unwrap();
    for n in 0..5 {
        let mut foreign = scope.clone();
        match n {
            0 => foreign.window = "other".into(),
            1 => foreign.document = "new".into(),
            2 => foreign.lease.generation += 1,
            3 => foreign.interaction = "later".into(),
            _ => foreign.lease.panel_id = "tasks".into(),
        }
        assert!(owner.cancel_forwarding_test(&id, foreign).is_err());
        assert!(!*cancel.borrow());
    }
    owner
        .end_interaction("main", &document, &lease, &scope.interaction)
        .unwrap();
    owner.cancel_forwarding_test(&id, scope.clone()).unwrap();
    assert!(*cancel.borrow());
    assert!(owner.panels["forwarding"].native_actions.contains(&action));
    owner.finish_forwarding_action("forwarding", "wrong-action");
    assert!(owner.panels["forwarding"].native_actions.contains(&action));
    owner.finish_forwarding_action("forwarding", &action);
    let next = owner.begin_interaction("main", &document, &lease).unwrap();
    let new_scope = Scope::new("main", &document, &lease, &next);
    let replacement = owner
        .begin_forwarding("main", &document, &lease, &request(&id, &new_scope))
        .unwrap();
    assert!(owner.cancel_forwarding_test(&id, scope).is_err());
    assert!(!*owner
        .forwarding_tests
        .receiver(&id, &replacement)
        .unwrap()
        .borrow());
}
#[test]
fn original_interaction_retirement_and_reload_signal_cancel_without_settling_actual_work() {
    for reload in [false, true] {
        let (mut owner, document, lease, scope) = setup();
        let id = uuid::Uuid::new_v4().to_string();
        let action = owner
            .begin_forwarding("main", &document, &lease, &request(&id, &scope))
            .unwrap();
        let cancel = owner.forwarding_tests.receiver(&id, &action).unwrap();
        if reload {
            owner.register("main").unwrap();
        } else {
            owner
                .end_interaction("main", &document, &lease, &scope.interaction)
                .unwrap();
        }
        owner.prune_forwarding_tests();
        assert!(*cancel.borrow());
        assert!(owner.panels["forwarding"].native_actions.contains(&action));
        assert!(owner.forwarding_tests.records.contains_key(&id));
        assert!(owner.forwarding_tests.complete(&id, &action).is_err());
        owner.finish_forwarding_action("forwarding", &action);
        assert!(!owner.forwarding_tests.records.contains_key(&id));
    }
}
#[test]
fn result_commit_wins_once_and_dialog_tombstones_prevent_replay() {
    let (mut owner, document, lease, scope) = setup();
    let id = uuid::Uuid::new_v4().to_string();
    let action = owner
        .begin_forwarding("main", &document, &lease, &request(&id, &scope))
        .unwrap();
    let cancel = owner.forwarding_tests.receiver(&id, &action).unwrap();
    owner.forwarding_tests.complete(&id, &action).unwrap();
    owner.cancel_forwarding_test(&id, scope.clone()).unwrap();
    assert!(!*cancel.borrow());
    assert!(owner.forwarding_tests.complete(&id, &action).is_err());
    owner.finish_forwarding_action("forwarding", &action);
    assert!(owner
        .begin_forwarding("main", &document, &lease, &request(&id, &scope))
        .is_err());
    assert!(owner.panels["forwarding"].native_actions.is_empty());
}
#[test]
fn bounded_dialog_history_never_evicts_live_cancellation_to_admit_a_late_test() {
    let (mut owner, document, lease, scope) = setup();
    let first = uuid::Uuid::new_v4().to_string();
    owner.cancel_forwarding_test(&first, scope.clone()).unwrap();
    for _ in 1..LIMIT {
        owner
            .cancel_forwarding_test(&uuid::Uuid::new_v4().to_string(), scope.clone())
            .unwrap();
    }
    assert_eq!(
        owner
            .cancel_forwarding_test(&uuid::Uuid::new_v4().to_string(), scope.clone())
            .unwrap_err(),
        "ssh.sessionBusy"
    );
    assert!(owner
        .begin_forwarding("main", &document, &lease, &request(&first, &scope))
        .is_err());
    owner
        .end_interaction("main", &document, &lease, &scope.interaction)
        .unwrap();
    owner.prune_forwarding_tests();
    assert!(owner.forwarding_tests.records.is_empty());
}
#[test]
fn grammar_never_accepts_a_global_test_id_window_or_provider_escape_hatch() {
    let id = uuid::Uuid::new_v4().to_string();
    for operation in ["test", "cancelTest"] {
        let mut wire = json!({"operation":operation,"testId":id,"interaction":"original"});
        if operation == "test" {
            wire["id"] = json!("rule");
            wire["revision"] = json!("one");
            wire["review"] = json!({"hostId":"host","revision":"a".repeat(64)});
        }
        assert!(serde_json::from_value::<Request>(wire.clone())
            .unwrap()
            .validate()
            .is_ok());
        for field in [
            "window",
            "origin",
            "globalTestId",
            "hostId",
            "request",
            "sessionId",
        ] {
            let mut invalid = wire.clone();
            invalid[field] = json!("foreign");
            assert!(serde_json::from_value::<Request>(invalid).is_err());
        }
        for bad in ["", "not-uuid", "A1234567-89AB-4CDE-8FAB-0123456789AB"] {
            let mut invalid = wire.clone();
            invalid["testId"] = json!(bad);
            assert!(serde_json::from_value::<Request>(invalid)
                .unwrap()
                .validate()
                .is_err());
        }
    }
}
#[tokio::test]
async fn cancel_during_admitted_blocking_work_keeps_lifetime_until_its_actual_return() {
    use crate::services::operations::{Budget, Errors};
    use std::time::Duration;
    let fence = Arc::new(());
    let weak = Arc::downgrade(&fence);
    let (entered, admitted) = tokio::sync::oneshot::channel();
    let (release, released) = std::sync::mpsc::channel();
    let (cancel, signal) = watch::channel(false);
    let running = tokio::spawn(WorkLifetime::new(fence).scope(async move {
        guard(
            signal,
            Budget::new(
                1,
                Errors {
                    domain: "test",
                    busy: "busy",
                    cancelled: "cancelled",
                    failed: "failed",
                },
            )
            .blocking(move |job| {
                job.commit()?;
                entered.send(()).unwrap();
                released.recv_timeout(Duration::from_secs(5)).unwrap();
                Ok(())
            }),
        )
        .await
    }));
    admitted.await.unwrap();
    cancel.send_replace(true);
    assert_eq!(
        running.await.unwrap().unwrap_err().to_string(),
        "ssh.testCancelled"
    );
    assert!(
        weak.upgrade().is_some(),
        "cancel result is not IO settlement"
    );
    release.send(()).unwrap();
    for _ in 0..500 {
        if weak.upgrade().is_none() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
    panic!("actual worker retained the fence after return");
}

#[test]
fn provider_test_cancellation_is_not_builtin_or_replacement_child_authority() {
    let mut ownership = Ownership::default();
    let document = ownership.register("main").unwrap();
    ownership.ready("main", &document).unwrap();
    let lease = ownership
        .add_panel("main", &document, "forwarding")
        .unwrap();
    let interaction = ownership
        .begin_interaction("main", &document, &lease)
        .unwrap();
    let builtin = Scope::new("main", &document, &lease, &interaction);
    let original = builtin.clone().provider(Some("retired-original-child"));
    let (cancel, receiver) = watch::channel(false);
    let id = uuid::Uuid::new_v4().to_string();
    ownership.forwarding_tests.records.insert(
        id.clone(),
        Record {
            scope: original.clone(),
            action: Some("actual-effect".into()),
            completed: false,
            cancel,
        },
    );
    assert!(ownership
        .cancel_forwarding_test(&id, builtin.clone())
        .is_err());
    assert!(ownership
        .cancel_forwarding_test(&id, builtin.provider(Some("replacement-child")))
        .is_err());
    assert!(!*receiver.borrow());
    // Exact cleanup remains available after child retirement; no new grant.
    ownership.cancel_forwarding_test(&id, original).unwrap();
    assert!(*receiver.borrow());
    assert_eq!(
        ownership.forwarding_tests.records[&id].action.as_deref(),
        Some("actual-effect")
    );
}
