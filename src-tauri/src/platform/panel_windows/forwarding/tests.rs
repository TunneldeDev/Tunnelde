use super::*;
use serde_json::json;

fn stop() -> Request {
    serde_json::from_value(
        json!({"operation":"stop","id":"rule","revision":"one","runtimeId":null}),
    )
    .unwrap()
}
fn save(bind: &str, interaction: Option<&str>) -> Value {
    json!({"operation":"save","rule":{"id":"","hostId":"host","name":"Forward","mode":"local","bindHost":bind,"bindPort":8080,"targetHost":"localhost","targetPort":80},"revision":null,"groupId":null,"automation":{"autoStart":false,"autoRetry":true},"interaction":interaction})
}
#[test]
fn closed_grammar_and_bounded_targets_never_accept_authority_or_arbitrary_commands() {
    assert!(stop().validate().is_ok());
    let loopback: Request = serde_json::from_value(save("127.0.0.1", None)).unwrap();
    assert!(loopback.validate().is_ok());
    let exposed: Request = serde_json::from_value(save("0.0.0.0", None)).unwrap();
    assert!(exposed.validate().is_err());
    for invalid in [
        json!({"operation":"invoke","command":"ssh_connect"}),
        json!({"operation":"stop","id":"rule","revision":"one","origin":{"token":"provider","scope":"scope"}}),
        json!({"operation":"stop","id":"rule","revision":"one","window":"main"}),
        json!({"operation":"stop","id":"rule","revision":"one","password":"secret"}),
        json!({"operation":"start","id":"rule","revision":"one"}),
    ] {
        assert!(serde_json::from_value::<Request>(invalid).is_err());
    }
    for (field, value) in [
        ("id", json!("")),
        ("revision", json!("")),
        ("runtimeId", json!("x".repeat(129))),
    ] {
        let mut wire = json!({"operation":"stop","id":"rule","revision":"one","runtimeId":null});
        wire[field] = value;
        assert!(serde_json::from_value::<Request>(wire)
            .unwrap()
            .validate()
            .is_err());
    }
    let mut existing = save("localhost", None);
    existing["rule"]["id"] = json!("existing");
    assert!(serde_json::from_value::<Request>(existing.clone())
        .unwrap()
        .validate()
        .is_err());
    existing["revision"] = json!("current");
    assert!(serde_json::from_value::<Request>(existing)
        .unwrap()
        .validate()
        .is_ok());
    for wire in [
        json!({"operation":"saveGroup","hostId":"host","name":"Group","id":"group"}),
        json!({"operation":"saveGroup","hostId":"host","name":"Group","revision":"one"}),
        json!({"operation":"removeGroup","id":"group","revision":""}),
    ] {
        assert!(serde_json::from_value::<Request>(wire)
            .unwrap()
            .validate()
            .is_err());
    }
}
#[test]
fn admission_and_final_gate_require_exact_window_document_lease_and_consent() {
    let mut registry = Ownership::default();
    let main = registry.register("main").unwrap();
    let other = registry.register("other").unwrap();
    registry.ready("main", &main).unwrap();
    registry.ready("other", &other).unwrap();
    let lease = registry.add_panel("main", &main, "forwarding").unwrap();
    let wrong = registry.add_panel("main", &main, "connections").unwrap();
    assert!(registry
        .begin_forwarding("main", &main, &wrong, &stop())
        .is_err());
    assert!(registry
        .begin_forwarding("other", &other, &lease, &stop())
        .is_err());
    assert!(registry
        .begin_forwarding("main", "old-document", &lease, &stop())
        .is_err());
    let mut stale = lease.clone();
    stale.generation += 1;
    assert!(registry
        .begin_forwarding("main", &main, &stale, &stop())
        .is_err());
    registry.block("main", &main, "forwarding", true).unwrap();
    assert!(registry
        .begin_forwarding("main", &main, &lease, &stop())
        .is_err());
    registry.block("main", &main, "forwarding", false).unwrap();
    let interaction = registry.begin_interaction("main", &main, &lease).unwrap();
    let exposed: Request = serde_json::from_value(save("0.0.0.0", Some(&interaction))).unwrap();
    let id = registry
        .begin_forwarding("main", &main, &lease, &exposed)
        .unwrap();
    assert!(registry
        .begin_forwarding("main", &main, &lease, &stop())
        .is_err());
    assert!(registry
        .forwarding_current("main", &main, &lease, &exposed)
        .is_ok());
    registry
        .end_interaction("main", &main, &lease, &interaction)
        .unwrap();
    // Consent disappearance before the blocking worker reaches CAS rejects.
    assert!(registry
        .forwarding_current("main", &main, &lease, &exposed)
        .is_err());
    assert!(registry.panels["forwarding"].native_actions.contains(&id));
    registry.finish_native_action("forwarding", &id);
    let fake: Request = serde_json::from_value(save("0.0.0.0", Some("fake"))).unwrap();
    assert!(registry
        .begin_forwarding("main", &main, &lease, &fake)
        .is_err());
    let id = registry
        .begin_forwarding("main", &main, &lease, &stop())
        .unwrap();
    let replacement = registry.register("main").unwrap();
    registry.ready("main", &replacement).unwrap();
    assert!(registry
        .forwarding_current("main", &main, &lease, &stop())
        .is_err());
    assert!(registry.panels["forwarding"].native_actions.contains(&id));
    let current = registry.panels["forwarding"].lease.clone();
    assert!(registry
        .begin_forwarding("main", &replacement, &current, &stop())
        .is_err());
    assert!(registry
        .remove_panel("main", &replacement, "forwarding")
        .is_err());
    registry.finish_native_action("forwarding", &id);
    registry
        .begin_forwarding("main", &replacement, &current, &stop())
        .unwrap();
}
#[test]
fn unready_source_never_gets_resource_admission_and_discovery_stays_closed() {
    let mut registry = Ownership::default();
    let main = registry.register("main").unwrap();
    let target = registry.register("target").unwrap();
    let lease = registry.add_panel("main", &main, "forwarding").unwrap();
    assert!(registry
        .begin_forwarding("main", &main, &lease, &stop())
        .is_err());
    registry.ready("main", &main).unwrap();
    registry.ready("target", &target).unwrap();
    // This is a gateway prerequisite, NOT permission to transfer a view for
    // which prompts/providers/renderer are not yet integrated.
    assert!(!super::super::ownership::transferable("forwarding"));
    assert!(registry
        .authorize_creation("main", &main, Some(&lease))
        .is_err());
    // Internal ownership preparation is not discovery admission. Exercise the
    // frozen and staged gates using it, without changing public transferability.
    let now = std::time::Instant::now();
    let offer = registry
        .prepare("main", &main, &lease, "target", Value::Null, now)
        .unwrap();
    assert!(registry
        .begin_forwarding("main", &main, &lease, &stop())
        .is_err());
    assert!(registry
        .begin_forwarding("target", &target, &lease, &stop())
        .is_err());
    registry.cancel("main", &main, &offer.id).unwrap();
    assert!(registry
        .begin_forwarding("main", &main, &lease, &stop())
        .is_ok());
}

#[test]
fn deletion_requires_original_live_confirmation_and_keeps_native_fence_until_settlement() {
    let mut registry = Ownership::default();
    let main = registry.register("main").unwrap();
    registry.ready("main", &main).unwrap();
    let lease = registry.add_panel("main", &main, "forwarding").unwrap();
    let confirmation = registry.begin_interaction("main", &main, &lease).unwrap();
    let wire = json!({"operation":"remove","id":"rule","revision":"one","runtimeId":"runtime","interaction":confirmation});
    let request: Request = serde_json::from_value(wire.clone()).unwrap();
    assert!(request.validate().is_ok());
    for field in ["id", "revision", "runtimeId", "interaction"] {
        let mut invalid = wire.clone();
        invalid[field] = json!("");
        assert!(serde_json::from_value::<Request>(invalid)
            .unwrap()
            .validate()
            .is_err());
    }
    let mut missing = wire.clone();
    missing.as_object_mut().unwrap().remove("interaction");
    assert!(serde_json::from_value::<Request>(missing).is_err());
    for (field, value) in [
        ("origin", json!({"token":"provider"})),
        ("sessionId", json!("ssh")),
        ("window", json!("main")),
    ] {
        let mut forged = wire.clone();
        forged[field] = value;
        assert!(serde_json::from_value::<Request>(forged).is_err());
    }
    let id = registry
        .begin_forwarding("main", &main, &lease, &request)
        .unwrap();
    assert!(registry
        .forwarding_current("main", &main, &lease, &request)
        .is_ok());
    registry
        .end_interaction("main", &main, &lease, &confirmation)
        .unwrap();
    let later = registry.begin_interaction("main", &main, &lease).unwrap();
    assert_ne!(later, confirmation);
    // A replacement confirmation in the same document cannot approve the old
    // request after a dialog cancellation/target change.
    assert!(registry
        .forwarding_current("main", &main, &lease, &request)
        .is_err());
    registry
        .end_interaction("main", &main, &lease, &later)
        .unwrap();
    let replacement = registry.register("main").unwrap();
    registry.ready("main", &replacement).unwrap();
    assert!(registry
        .forwarding_current("main", &main, &lease, &request)
        .is_err());
    // If deletion already committed, response cancellation/reload must not
    // allow another action, panel removal or transfer before socket cleanup.
    assert!(registry
        .remove_panel("main", &replacement, "forwarding")
        .is_err());
    let current = registry.panels["forwarding"].lease.clone();
    assert!(registry
        .begin_forwarding("main", &replacement, &current, &stop())
        .is_err());
    registry.finish_native_action("forwarding", "wrong-operation");
    assert!(registry.panels["forwarding"].native_actions.contains(&id));
    registry.finish_native_action("forwarding", &id);
    registry
        .remove_panel("main", &replacement, "forwarding")
        .unwrap();
}

#[test]
fn reviewed_start_grammar_requires_original_consent_and_never_accepts_arbitrary_ssh_inputs() {
    let review = json!({"hostId":"host","revision":"a".repeat(64)});
    let wire = json!({"operation":"start","id":"rule","revision":"one","interaction":"consent","review":review,"credentials":{"password":"ephemeral","jumps":{"jump":{"passphrase":"ephemeral-hop"}}}});
    assert!(serde_json::from_value::<Request>(wire.clone())
        .unwrap()
        .validate()
        .is_ok());
    for (field, value) in [
        ("origin", json!({"scope":"provider"})),
        ("window", json!("main")),
        ("request", json!({"hostId":"foreign","purpose":"terminal"})),
        ("sessionId", json!("ssh")),
    ] {
        let mut invalid = wire.clone();
        invalid[field] = value;
        assert!(serde_json::from_value::<Request>(invalid).is_err());
    }
    for credentials in [
        json!({"password":"x".repeat(128*1024+1)}),
        json!({"jumps":{"":{"password":"x"}}}),
        json!({"background":false}),
        json!({"jumps":{"jump":{"host":"injected"}}}),
    ] {
        let mut invalid = wire.clone();
        invalid["credentials"] = credentials;
        assert!(match serde_json::from_value::<Request>(invalid) {
            Err(_) => true,
            Ok(r) => r.validate().is_err(),
        });
    }
    for field in ["id", "revision", "interaction"] {
        let mut invalid = wire.clone();
        invalid[field] = json!("");
        assert!(serde_json::from_value::<Request>(invalid)
            .unwrap()
            .validate()
            .is_err());
    }
    let mut registry = Ownership::default();
    let document = registry.register("main").unwrap();
    registry.ready("main", &document).unwrap();
    let lease = registry.add_panel("main", &document, "forwarding").unwrap();
    let consent = registry
        .begin_interaction("main", &document, &lease)
        .unwrap();
    let mut current = wire.clone();
    current["interaction"] = json!(consent);
    let request = serde_json::from_value::<Request>(current).unwrap();
    let action = registry
        .begin_forwarding("main", &document, &lease, &request)
        .unwrap();
    registry
        .end_interaction("main", &document, &lease, &consent)
        .unwrap();
    assert!(registry
        .forwarding_current("main", &document, &lease, &request)
        .is_err());
    assert!(registry.panels["forwarding"]
        .native_actions
        .contains(&action));
    registry.finish_native_action("forwarding", &action);
}

#[test]
fn probe_and_trust_are_bounded_reviewed_interactions_not_generic_host_key_commands() {
    let review = json!({"hostId":"host","revision":"a".repeat(64)});
    for operation in ["probe", "trust"] {
        let mut wire = json!({"operation":operation,"id":"rule","revision":"one","interaction":"original","review":review,"credentials":{"jump":{"password":"ephemeral"}}});
        if operation == "trust" {
            wire["fingerprint"] = json!("SHA256:observed");
            wire["expectedHostId"] = json!("jump");
        }
        let request: Request = serde_json::from_value(wire.clone()).unwrap();
        assert!(request.validate().is_ok());
        assert_eq!(request.interaction(), Some("original"));
        for field in ["id", "revision", "interaction"] {
            let mut invalid = wire.clone();
            invalid[field] = json!("");
            assert!(serde_json::from_value::<Request>(invalid)
                .unwrap()
                .validate()
                .is_err());
        }
        for (field, value) in [
            ("origin", json!({"token":"provider"})),
            ("window", json!("main")),
            ("hostId", json!("foreign")),
            ("request", json!({"purpose":"terminal"})),
            ("credentials", json!({"jump":{"host":"foreign"}})),
            ("credentials", json!({"password":"not-a-jump-map"})),
        ] {
            let mut invalid = wire.clone();
            invalid[field] = value;
            assert!(serde_json::from_value::<Request>(invalid).is_err());
        }
        for credentials in [
            json!({"jump":{"password":"x".repeat(128*1024+1)}}),
            json!({"":{"password":"x"}}),
            json!({"jump\n":{"passphrase":"x"}}),
            serde_json::Value::Object(
                (0..9)
                    .map(|n| (format!("jump{n}"), json!({"password":"x"})))
                    .collect(),
            ),
            serde_json::Value::Object(
                (0..5)
                    .map(|n| (format!("jump{n}"), json!({"password":"x".repeat(128*1024)})))
                    .collect(),
            ),
        ] {
            let mut invalid = wire.clone();
            invalid["credentials"] = credentials;
            assert!(serde_json::from_value::<Request>(invalid)
                .unwrap()
                .validate()
                .is_err());
        }
        let mut registry = Ownership::default();
        let document = registry.register("main").unwrap();
        registry.ready("main", &document).unwrap();
        let lease = registry.add_panel("main", &document, "forwarding").unwrap();
        let consent = registry
            .begin_interaction("main", &document, &lease)
            .unwrap();
        wire["interaction"] = json!(consent);
        let original: Request = serde_json::from_value(wire).unwrap();
        let action = registry
            .begin_forwarding("main", &document, &lease, &original)
            .unwrap();
        registry
            .end_interaction("main", &document, &lease, &consent)
            .unwrap();
        registry
            .begin_interaction("main", &document, &lease)
            .unwrap();
        assert!(registry
            .forwarding_current("main", &document, &lease, &original)
            .is_err());
        assert!(registry.panels["forwarding"]
            .native_actions
            .contains(&action));
        registry.finish_native_action("forwarding", &action);
    }
}
