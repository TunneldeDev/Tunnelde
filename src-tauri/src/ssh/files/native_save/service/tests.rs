use super::*;
use crate::ssh::files::native_save::{
    contracts::authority::{Authority, Context, Platform},
    testing::*,
    transport::Output,
};
use serde_json::Value;
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

#[derive(Clone, Default)]
struct MemorySecrets {
    values: Arc<Mutex<HashMap<String, String>>>,
    unavailable: Arc<AtomicBool>,
}
impl Secrets for MemorySecrets {
    fn create(&self, key: &str, token: &str) -> journal::Result<()> {
        if self.unavailable.load(Ordering::Acquire) {
            return Err(journal::Error::SecretUnavailable);
        }
        let mut values = self.values.lock().unwrap();
        if values.get(key).is_some_and(|old| old != token) {
            return Err(journal::Error::SecretChanged);
        }
        values.insert(key.into(), token.into());
        Ok(())
    }
    fn load(&self, key: &str) -> journal::Result<String> {
        if self.unavailable.load(Ordering::Acquire) {
            return Err(journal::Error::SecretUnavailable);
        }
        self.values
            .lock()
            .unwrap()
            .get(key)
            .cloned()
            .ok_or(journal::Error::SecretChanged)
    }
}
struct Fixture {
    root: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("tunnelde-service-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        Self { root }
    }
    fn path(&self) -> PathBuf {
        self.root.join("native-file-saves")
    }
    fn service(&self, secrets: MemorySecrets) -> Service<MemorySecrets> {
        Service::new(Journal::create(&self.path()).unwrap(), secrets)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.root).unwrap();
    }
}
struct Mock {
    context: Context,
    path: PathBuf,
    requests: Mutex<Vec<Value>>,
    responses: Mutex<Vec<Result<Value, transport::Failure>>>,
    revoked: AtomicBool,
}
impl Exchange for Mock {
    fn authorize(&self, context: &Context) -> Result<(), transport::Failure> {
        if *context != self.context || self.revoked.load(Ordering::Acquire) {
            return Err(transport::Failure::before(
                transport::Reason::AuthorityChanged,
            ));
        }
        Ok(())
    }
    async fn exchange(&self, input: Vec<u8>) -> Result<Output, transport::Failure> {
        let request: Value = serde_json::from_slice(&input).unwrap();
        let journal = Journal::open(&self.path).unwrap();
        let record = journal
            .records()
            .unwrap()
            .into_iter()
            .find(|record| record.binding.operation_id == request["control"]["operationId"])
            .unwrap();
        assert!(
            record.stage == Stage::Dispatched,
            "FULL checkpoint must precede any network dispatch"
        );
        if request["method"] == "release" {
            assert!(record.release.is_some());
        }
        self.requests.lock().unwrap().push(request);
        self.responses
            .lock()
            .unwrap()
            .pop()
            .expect("no automatic retries")
            .map(output)
    }
}
fn client(
    fixture: &Fixture,
    authority: &Authority,
    responses: Vec<Result<Value, transport::Failure>>,
) -> Client<Mock> {
    Client::restore(
        Mock {
            context: authority.context.clone(),
            path: fixture.path(),
            requests: Mutex::new(Vec::new()),
            responses: Mutex::new(responses.into_iter().rev().collect()),
            revoked: false.into(),
        },
        authority.clone(),
        Platform::Posix,
    )
    .unwrap()
}
fn lost() -> transport::Failure {
    transport::Failure {
        reason: transport::Reason::Timeout,
        dispatched: true,
    }
}

#[tokio::test]
async fn lost_submit_reopens_original_journal_and_recovers_without_payload_or_resubmit() {
    let fixture = Fixture::new();
    let secrets = MemorySecrets::default();
    let service = fixture.service(secrets.clone());
    let authority = authority();
    let prepared = prepared(&authority);
    let saved = service
        .reserve(binding(&authority, &prepared), &prepared)
        .unwrap();
    let client = client(
        &fixture,
        &authority,
        vec![
            Err(lost()),
            Ok(response(
                &authority,
                Some(&prepared.control),
                "succeeded",
                4,
            )),
        ],
    );
    assert!(matches!(
        service.submit(&saved, &prepared, &client, |_| Ok(())).await,
        Err(Error::Remote(_))
    ));
    let original = service.records().unwrap().pop().unwrap();
    assert!(original.stage == Stage::Dispatched);
    assert!(service
        .submit(&original, &prepared, &client, |_| Ok(()))
        .await
        .is_err());
    drop(service);
    drop(prepared); // recovery cannot access or replay the text
    let restored = Service::new(Journal::open(&fixture.path()).unwrap(), secrets);
    let settled = restored
        .recover(&original, &client, |_| Ok(()))
        .await
        .unwrap();
    assert_eq!(
        settled.observation.as_ref().unwrap().phase,
        super::super::contracts::receipt::Phase::Succeeded
    );
    let calls = client.test_transport().requests.lock().unwrap();
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[0]["method"], "submit");
    assert_eq!(calls[1]["method"], "status");
    assert_eq!(calls[0]["control"], calls[1]["control"]);
    assert!(calls[1].get("content").is_none());
}

#[tokio::test]
async fn missing_changed_and_unavailable_secrets_never_rotate_or_send() {
    for failure in ["missing", "changed", "unavailable"] {
        let fixture = Fixture::new();
        let secrets = MemorySecrets::default();
        let service = fixture.service(secrets.clone());
        let authority = authority();
        let prepared = prepared(&authority);
        let record = service
            .reserve(binding(&authority, &prepared), &prepared)
            .unwrap();
        let client = client(&fixture, &authority, vec![]);
        match failure {
            "missing" => {
                secrets.values.lock().unwrap().clear();
            }
            "changed" => {
                secrets
                    .values
                    .lock()
                    .unwrap()
                    .insert(record.secret_key(), "0".repeat(64));
            }
            _ => {
                secrets.unavailable.store(true, Ordering::Release);
            }
        }
        assert!(service
            .submit(&record, &prepared, &client, |_| Ok(()))
            .await
            .is_err());
        assert!(client.test_transport().requests.lock().unwrap().is_empty());
        assert!(service.records().unwrap()[0] == record);
    }
}

#[tokio::test]
async fn secret_setup_failure_keeps_unsent_reservation_and_never_admits_recovery() {
    let fixture = Fixture::new();
    let secrets = MemorySecrets::default();
    secrets.unavailable.store(true, Ordering::Release);
    let service = fixture.service(secrets);
    let authority = authority();
    let prepared = prepared(&authority);
    assert!(service
        .reserve(binding(&authority, &prepared), &prepared)
        .is_err());
    let reserved = service.records().unwrap().pop().unwrap();
    assert!(reserved.stage == Stage::Reserved);
    let client = client(&fixture, &authority, vec![]);
    assert!(service
        .recover(&reserved, &client, |_| Ok(()))
        .await
        .is_err());
    assert!(client.test_transport().requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn revoked_owner_or_changed_authority_cannot_submit_or_disclose_control() {
    for owner_revoked in [true, false] {
        let fixture = Fixture::new();
        let service = fixture.service(MemorySecrets::default());
        let authority = authority();
        let prepared = prepared(&authority);
        let record = service
            .reserve(binding(&authority, &prepared), &prepared)
            .unwrap();
        let client = client(&fixture, &authority, vec![]);
        client
            .test_transport()
            .revoked
            .store(!owner_revoked, Ordering::Release);
        assert!(service
            .submit(&record, &prepared, &client, |_| {
                // The final owner check must see the already committed checkpoint.
                assert!(service.records().unwrap()[0].stage == Stage::Dispatched);
                if owner_revoked {
                    Err(journal::Error::Changed)
                } else {
                    Ok(())
                }
            })
            .await
            .is_err());
        assert!(client.test_transport().requests.lock().unwrap().is_empty());
        // Pre-network refusal still retains the conservative possible-dispatch checkpoint.
        assert!(service.records().unwrap()[0].stage == Stage::Dispatched);
    }
}

#[tokio::test]
async fn missing_original_remote_operation_preserves_unknown_and_blocks_overlap() {
    let fixture = Fixture::new();
    let service = fixture.service(MemorySecrets::default());
    let authority = authority();
    let prepared = prepared(&authority);
    let record = service
        .reserve(binding(&authority, &prepared), &prepared)
        .unwrap();
    let client = client(
        &fixture,
        &authority,
        vec![Err(lost()), Ok(response(&authority, None, "unknown", 1))],
    );
    service
        .submit(&record, &prepared, &client, |_| Ok(()))
        .await
        .err()
        .unwrap();
    let unknown = service.records().unwrap().pop().unwrap();
    assert!(matches!(
        service.recover(&unknown, &client, |_| Ok(())).await,
        Err(Error::Remote(transport::Failure {
            reason: transport::Reason::MissingOperation,
            ..
        }))
    ));
    assert!(service.records().unwrap()[0] == unknown);
    let second = super::super::testing::prepared(&authority);
    assert!(service
        .reserve(binding(&authority, &second), &second)
        .is_err());
}

#[tokio::test]
async fn cleanup_checkpoint_precedes_remote_release_and_lost_reply_is_query_only() {
    let fixture = Fixture::new();
    let service = fixture.service(MemorySecrets::default());
    let authority = authority();
    let prepared = prepared(&authority);
    let record = service
        .reserve(binding(&authority, &prepared), &prepared)
        .unwrap();
    let client = client(
        &fixture,
        &authority,
        vec![
            Ok(response(&authority, Some(&prepared.control), "conflict", 4)),
            Err(lost()),
            Ok(response(&authority, Some(&prepared.control), "released", 5)),
        ],
    );
    let terminal = service
        .submit(&record, &prepared, &client, |_| Ok(()))
        .await
        .unwrap();
    assert!(service
        .release(&terminal, &client, false, |_| Ok(()))
        .await
        .is_err());
    assert!(service
        .release(&terminal, &client, true, |_| Ok(()))
        .await
        .is_err());
    let releasing = service.records().unwrap().pop().unwrap();
    assert!(releasing.release.is_some());
    assert!(service
        .release(&releasing, &client, true, |_| Ok(()))
        .await
        .is_err());
    let released = service
        .recover(&releasing, &client, |_| Ok(()))
        .await
        .unwrap();
    assert!(released.released());
    let requests = client.test_transport().requests.lock().unwrap();
    assert_eq!(requests.len(), 3);
    assert_eq!(requests[1]["method"], "release");
    assert_eq!(requests[2]["method"], "status");
}
