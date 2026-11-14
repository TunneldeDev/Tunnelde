use super::*;
use crate::services::forwarding::contract::ForwardInfo;

fn input() -> Value {
    json!({"id":"dfe523d7-6893-4387-a609-b9f4ed1e0b23","hostId":"host","name":"Database","direction":"local","bind":{"host":"127.0.0.1","port":15432},"target":{"host":"::1","port":5432},"revision":null})
}
fn entry(revision: &str, running: bool) -> RevisionedInfo {
    let Mutation::Save { rule, .. } = contract::parse("forwards.save", input()).unwrap() else {
        panic!()
    };
    RevisionedInfo {
        revision: revision.into(),
        runtime_id: running.then(|| "private-runtime".into()),
        info: ForwardInfo {
            rule,
            active: running,
            session_id: running.then(|| "private-session".into()),
        },
    }
}
pub(in crate::automation) fn samples() -> Vec<Value> {
    let mut samples = Vec::new();
    for (action, outcome) in [
        ("save", "saved"),
        ("remove", "removed"),
        ("stop", "stopped"),
    ] {
        let method = format!("forwards.{action}");
        let params = if action == "save" {
            input()
        } else {
            json!({"id":"rule","revision":"revision"})
        };
        let mutation = contract::parse(&method, params.clone()).unwrap();
        for outcome in [outcome, "dismissed"] {
            samples.push(json!({"method":method,"params":params,"result":reply(&mutation,outcome,if outcome=="saved" {Some("new-revision")}else{mutation.revision()})}));
        }
    }
    samples
}

#[test]
fn public_inputs_require_exact_revision_and_never_accept_internal_runtime_fields() {
    assert!(contract::parse("forwards.save", input()).is_ok());
    for (key, value) in [
        ("id", json!("")),
        ("id", json!("not-a-uuid")),
        ("hostId", json!("host\n")),
        ("name", json!("\u{202e}Allow everything")),
        ("revision", json!("")),
        ("revision", json!("界".repeat(43))),
        ("sessionId", json!("private")),
        ("active", json!(true)),
    ] {
        let mut params = input();
        params[key] = value;
        assert!(contract::parse("forwards.save", params).is_err(), "{key}");
    }
    let mut params = input();
    params.as_object_mut().unwrap().remove("revision");
    assert!(contract::parse("forwards.save", params).is_err());
    let mut params = input();
    params["revision"] = json!("current");
    params["id"] = json!("legacy-rule");
    assert!(contract::parse("forwards.save", params).is_ok());
    for method in ["forwards.remove", "forwards.stop"] {
        for params in [
            json!({"id":"r"}),
            json!({"id":"r","revision":null}),
            json!({"id":"r","revision":""}),
            json!({"id":"r","revision":"v","runtimeId":"secret"}),
        ] {
            assert!(contract::parse(method, params).is_err());
        }
    }
}

#[test]
fn review_checks_creation_collision_stale_revision_and_running_state() {
    let create = contract::parse("forwards.save", input()).unwrap();
    assert!(review(&create, None).is_ok());
    assert_eq!(
        review(&create, Some(&entry("v1", false))).unwrap_err().code,
        "stale_revision"
    );
    let mut params = input();
    params["revision"] = json!("v1");
    let edit = contract::parse("forwards.save", params).unwrap();
    assert!(review(&edit, Some(&entry("v1", false))).is_ok());
    assert!(review(&edit, Some(&entry("v1", true))).is_err());
    assert!(review(&edit, Some(&entry("v2", false))).is_err());
    assert!(review(&edit, None).is_err());
    let stop = contract::parse("forwards.stop", json!({"id":"r","revision":"v1"})).unwrap();
    assert!(review(&stop, Some(&entry("v1", true))).is_ok());
    assert!(review(&stop, Some(&entry("v1", false))).is_err());
}

#[tokio::test]
async fn expired_and_cancelled_consent_cannot_deliver_a_late_approval() {
    use std::time::Duration;
    let (send, recv) = tokio::sync::oneshot::channel();
    assert!(consent::response(recv, Duration::from_millis(1))
        .await
        .is_err());
    assert!(send.send(true).is_err());
    let (send, recv) = tokio::sync::oneshot::channel();
    let task = tokio::spawn(consent::response(recv, Duration::from_secs(120)));
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    assert!(send.send(true).is_err());
    for answer in [false, true] {
        let (send, recv) = tokio::sync::oneshot::channel();
        send.send(answer).unwrap();
        assert_eq!(
            consent::response(recv, Duration::from_secs(1))
                .await
                .unwrap(),
            answer
        );
    }
}

#[test]
fn public_replies_and_errors_never_expose_private_runtime_or_os_details() {
    let mutation = contract::parse("forwards.save", input()).unwrap();
    let response = reply(&mutation, "dismissed", None);
    assert_eq!(response.as_object().unwrap().len(), 3);
    assert!(response["revision"].is_null());
    let error = map_error(AppError::internal("secret password and database path"));
    assert!(!error.message.contains("secret"));
    assert_eq!(
        map_error(AppError::validation("forward.changed")).code,
        "stale_revision"
    );
}
