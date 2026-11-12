use super::super::contracts::operation::Baseline;
use super::super::{testing::*, transport::Output};
use super::*;
use serde_json::{json, Value};
use std::sync::Mutex;

struct Mock {
    context: Context,
    responses: Mutex<Vec<Result<Output, Failure>>>,
    requests: Mutex<Vec<Value>>,
    revoked: std::sync::atomic::AtomicBool,
}
impl Mock {
    fn new(authority: &Authority, values: Vec<Value>) -> Self {
        Self {
            context: authority.context.clone(),
            responses: Mutex::new(values.into_iter().rev().map(|v| Ok(output(v))).collect()),
            requests: Mutex::new(Vec::new()),
            revoked: false.into(),
        }
    }
}
impl Exchange for Mock {
    fn authorize(&self, context: &Context) -> Result<(), Failure> {
        if self.revoked.load(std::sync::atomic::Ordering::Acquire) || self.context != *context {
            Err(Failure::before(Reason::AuthorityChanged))
        } else {
            Ok(())
        }
    }
    async fn exchange(&self, input: Vec<u8>) -> Result<Output, Failure> {
        self.requests
            .lock()
            .unwrap()
            .push(serde_json::from_slice(&input).unwrap());
        self.responses
            .lock()
            .unwrap()
            .pop()
            .expect("no implicit retry")
    }
}
fn receipt(authority: &Authority, prepared: &Prepared, phase: &str, revision: u64) -> Observation {
    serde_json::from_value(
        response(authority, Some(&prepared.control), phase, revision)["observation"].clone(),
    )
    .unwrap()
}
#[tokio::test]
async fn restoration_and_each_call_verify_destination_before_disclosing_private_control() {
    let authority = authority();
    let saved = prepared(&authority);
    let mut wrong = authority.clone();
    wrong.context.account = "other".into();
    assert_eq!(
        Client::restore(Mock::new(&authority, vec![]), wrong, Platform::Posix)
            .err()
            .unwrap()
            .reason,
        Reason::AuthorityChanged
    );
    let client =
        Client::restore(Mock::new(&authority, vec![]), authority, Platform::Posix).unwrap();
    client
        .transport
        .revoked
        .store(true, std::sync::atomic::Ordering::Release);
    let error = client.status(&saved.control, None).await.err().unwrap();
    assert!(!error.dispatched);
    assert!(client.transport.requests.lock().unwrap().is_empty());
}
#[tokio::test]
async fn lost_submit_is_not_replayed_and_query_uses_the_exact_original_identity() {
    let authority = authority();
    let saved = prepared(&authority);
    let mock = Mock::new(
        &authority,
        vec![response(&authority, Some(&saved.control), "succeeded", 4)],
    );
    mock.responses.lock().unwrap().push(Err(Failure {
        reason: Reason::Timeout,
        dispatched: true,
    }));
    let client = Client::restore(mock, authority, Platform::Posix).unwrap();
    let mut checkpoint = Checkpoint::new(client.authority(), &saved);
    assert!(
        client
            .submit(&saved, checkpoint.take())
            .await
            .err()
            .unwrap()
            .dispatched
    );
    let found = client.status(&saved.control, None).await.unwrap().unwrap();
    assert_eq!(found.phase, Phase::Succeeded);
    let requests = client.transport.requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[0]["method"], "submit");
    assert_eq!(requests[1]["method"], "status");
    assert_eq!(requests[0]["control"], requests[1]["control"]);
    assert!(requests[1].get("content").is_none());
}
#[tokio::test]
async fn changed_payload_revision_or_settled_phase_cannot_be_accepted() {
    let authority = authority();
    let mut saved = prepared(&authority);
    let client = Client::restore(
        Mock::new(
            &authority,
            vec![response(&authority, Some(&saved.control), "succeeded", 2)],
        ),
        authority.clone(),
        Platform::Posix,
    )
    .unwrap();
    let mut checkpoint = Checkpoint::new(&authority, &saved);
    saved.content.push('x');
    assert!(
        !client
            .submit(&saved, checkpoint.take())
            .await
            .err()
            .unwrap()
            .dispatched
    );
    assert!(client.transport.requests.lock().unwrap().is_empty());
    let old = receipt(&authority, &saved, "succeeded", 3);
    assert_eq!(
        client
            .status(&saved.control, Some(&old))
            .await
            .err()
            .unwrap()
            .reason,
        Reason::StaleReceipt
    );
    let new = receipt(&authority, &saved, "failed", 4);
    assert!(!follows(&old, &new));
}
#[tokio::test]
async fn release_requires_actual_exclusion_revision_and_explicit_backup_discard() {
    let authority = authority();
    let saved = prepared(&authority);
    let mut old = receipt(&authority, &saved, "conflict", 5);
    let client = Client::restore(
        Mock::new(
            &authority,
            vec![response(&authority, Some(&saved.control), "released", 7)],
        ),
        authority.clone(),
        Platform::Posix,
    )
    .unwrap();
    assert_eq!(
        client
            .release(&saved.control, &old, false)
            .await
            .err()
            .unwrap()
            .reason,
        Reason::NotReleasable
    );
    old.live = None;
    assert!(client.release(&saved.control, &old, true).await.is_err());
    old.live = Some(true);
    assert!(client.release(&saved.control, &old, true).await.is_err());
    old.live = Some(false);
    let released = client.release(&saved.control, &old, true).await.unwrap();
    assert_eq!(released.phase, Phase::Released);
    let requests = client.transport.requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0]["revision"], json!(5));
    assert_eq!(requests[0]["discardBackup"], true);
}
#[test]
fn query_projection_and_monotonic_revision_do_not_invent_an_outcome() {
    let authority = authority();
    let saved = prepared(&authority);
    let old = receipt(&authority, &saved, "running", 2);
    let mut new = receipt(&authority, &saved, "unknown", 2);
    assert!(follows(&old, &new));
    new.phase = Phase::Prepared;
    assert!(!follows(&old, &new));
    new = receipt(&authority, &saved, "succeeded", 1);
    assert!(!follows(&old, &new));
    let settled = receipt(&authority, &saved, "succeeded", 5);
    assert!(!follows(&settled, &old));
    let releasing = receipt(&authority, &saved, "releasing", 6);
    assert!(follows(&settled, &releasing));
    let released = receipt(&authority, &saved, "released", 7);
    assert!(follows(&releasing, &released));
    assert!(!follows(
        &released,
        &receipt(&authority, &saved, "unknown", 8)
    ));
    let publishing = receipt(&authority, &saved, "publishing", 3);
    for phase in ["running", "failed", "cancelled"] {
        assert!(!follows(
            &publishing,
            &receipt(&authority, &saved, phase, 4)
        ));
    }
    assert!(!follows(&old, &receipt(&authority, &saved, "succeeded", 2)));
}
#[test]
fn canonical_hashes_and_remote_path_rules_do_not_depend_on_the_client_os() {
    use super::super::contracts::authority::ObjectIdentity;
    let authority = authority();
    assert_eq!(
        authority.binding(),
        "caec700b3f58ed3039ab5cd13eeac9c31fcd4340e8ea75993704870b681d3241"
    );
    assert!(Platform::Posix.absolute("/tmp/a'b $HOME"));
    assert!(!Platform::Posix.absolute("relative"));
    for path in [r"C:\work", r"\\?\C:\work", "C:/work"] {
        assert!(Platform::Windows.absolute(path), "{path}");
    }
    for path in [r"C:work", r"\\host\share", r"\\?\UNC\host\share", "/work"] {
        assert!(!Platform::Windows.absolute(path), "{path}");
    }
    for target in [
        vec!["..".into()],
        vec!["a/b".into()],
        vec!["\0".into()],
        vec![],
    ] {
        assert!(Prepared::new(&authority, target, Baseline::Absent, String::new()).is_none());
    }
    let mut windows = authority.clone();
    windows.context.scope = r"C:\work".into();
    windows.root = ObjectIdentity {
        platform: "windows".into(),
        device: "1".into(),
        object: "0:2".into(),
        created: "0:3".into(),
    };
    windows.storage_root = windows.root.clone();
    for name in ["NUL.txt", "COM1", "part:stream", "trailing.", "a\\b"] {
        assert!(
            Prepared::new(&windows, vec![name.into()], Baseline::Absent, String::new()).is_none(),
            "{name}"
        );
    }
}

#[test]
fn maximum_utf8_payload_is_bounded_after_json_escaping_and_rejects_overflow() {
    use super::super::contracts::{MAX_PACKET, MAX_TEXT};
    let authority = authority();
    let prepared = Prepared::new(
        &authority,
        vec!["control-text".into()],
        Baseline::Absent,
        "\u{0001}".repeat(MAX_TEXT),
    )
    .unwrap();
    let bytes = encode(&Request::Submit {
        control: &prepared.control,
        intent: &prepared.intent,
        content: &prepared.content,
    })
    .unwrap();
    assert!(bytes.len() > MAX_TEXT * 6);
    assert!(bytes.len() <= MAX_PACKET);
    assert!(Prepared::new(
        &authority,
        vec!["too-large".into()],
        Baseline::Absent,
        "x".repeat(MAX_TEXT + 1)
    )
    .is_none());
}
#[test]
fn authenticated_context_uses_original_account_and_validated_host_key() {
    use crate::ssh::session::SessionIdentity;
    let authority = authority();
    let mut identity = SessionIdentity {
        host_id: "test".into(),
        address: "user@domain@host:22".into(),
        server_key: authority.context.host_key.clone(),
    };
    let context = Context::authenticated(&identity, "/workspace".into(), Platform::Posix).unwrap();
    assert_eq!(context.account, "user@domain");
    identity.server_key = "SHA256:unverified".into();
    assert!(Context::authenticated(&identity, "/workspace".into(), Platform::Posix).is_none());
}

#[test]
fn unicode_and_escaped_intent_has_an_independent_canonical_digest_vector() {
    let authority = authority();
    let saved = prepared(&authority);
    assert_eq!(
        saved.intent.digest(),
        "3aedcb796c099d105758ff69fba534f4768cd7741420b682deda1c90763f9b0f"
    );
}
