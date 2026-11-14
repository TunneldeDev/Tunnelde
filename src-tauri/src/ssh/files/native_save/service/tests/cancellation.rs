use super::*;
use crate::ssh::files::native_save::contracts::receipt::{Phase, Publication};

#[tokio::test]
async fn cancellation_before_checkpoint_retires_only_the_unsent_reservation() {
    let fixture = Fixture::new();
    let secrets = MemorySecrets::default();
    let service = fixture.service(secrets.clone());
    let authority = authority();
    let prepared = prepared(&authority);
    let ready = service
        .reserve(binding(&authority, &prepared), &prepared)
        .await
        .unwrap();
    let worker = service.observe_save(&ready.binding).unwrap();
    let mut cancellation = worker.cancellation();
    service.request_save_cancel(&ready.binding).unwrap();
    let client = client(&fixture, &authority, vec![]);
    assert!(matches!(
        service
            .submit_cancellable(
                &ready,
                &prepared,
                &client,
                |_| panic!("unsent save cannot authorize network"),
                &mut cancellation,
            )
            .await,
        Err(Error::Cancelled)
    ));
    assert!(client.test_transport().requests.lock().unwrap().is_empty());
    assert!(service.records().await.unwrap().is_empty());
    assert!(secrets.values.lock().unwrap().is_empty());
}

#[tokio::test]
async fn cancellation_during_checkpoint_uses_original_control_without_submitting() {
    let fixture = Fixture::new();
    let service = fixture.service(MemorySecrets::default());
    let authority = authority();
    let prepared = prepared(&authority);
    let ready = service
        .reserve(binding(&authority, &prepared), &prepared)
        .await
        .unwrap();
    let worker = service.observe_save(&ready.binding).unwrap();
    let mut cancellation = worker.cancellation();
    let client = client(
        &fixture,
        &authority,
        vec![Ok(response(
            &authority,
            Some(&prepared.control),
            "cancelled",
            1,
        ))],
    );
    let cancelled = service
        .submit_cancellable(
            &ready,
            &prepared,
            &client,
            |binding| {
                assert!(
                    Journal::open(&fixture.path()).unwrap().records().unwrap()[0].stage
                        == Stage::Dispatched
                );
                service.request_save_cancel(binding)
            },
            &mut cancellation,
        )
        .await
        .unwrap();
    assert!(cancelled.observation.unwrap().phase == Phase::Cancelled);
    let requests = client.test_transport().requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0]["method"], "cancel");
    assert_eq!(
        requests[0]["control"]["operationId"],
        prepared.control.operation_id
    );
}

struct Racing {
    context: Context,
    started: tokio::sync::Semaphore,
    cancelled: tokio::sync::Semaphore,
    requests: Mutex<Vec<String>>,
    original: Value,
    cancel: Result<Value, transport::Failure>,
    drained: AtomicBool,
}
impl Exchange for Racing {
    fn authorize(&self, context: &Context) -> Result<(), transport::Failure> {
        assert!(*context == self.context);
        Ok(())
    }
    async fn exchange(&self, input: Vec<u8>) -> Result<Output, transport::Failure> {
        let request: Value = serde_json::from_slice(&input).unwrap();
        let method = request["method"].as_str().unwrap();
        self.requests.lock().unwrap().push(method.into());
        if method == "cancel" {
            self.cancelled.add_permits(1);
            self.cancel.clone().map(output)
        } else {
            self.started.add_permits(1);
            self.cancelled.acquire().await.unwrap().forget();
            self.drained.store(true, Ordering::Release);
            Ok(output(self.original.clone()))
        }
    }
}
async fn race(
    original_phase: &str,
    cancel_phase: Option<&str>,
    status: bool,
) -> (Record, Vec<String>, bool) {
    let fixture = Fixture::new();
    let secrets = MemorySecrets::default();
    let service = fixture.service(secrets.clone());
    let authority = authority();
    let prepared = prepared(&authority);
    let ready = service
        .reserve(binding(&authority, &prepared), &prepared)
        .await
        .unwrap();
    let ready = if status {
        let client = client(
            &fixture,
            &authority,
            vec![Ok(response(
                &authority,
                Some(&prepared.control),
                "prepared",
                1,
            ))],
        );
        service
            .submit(&ready, &prepared, &client, |_| Ok(()))
            .await
            .unwrap()
    } else {
        ready
    };
    let worker = service.observe_save(&ready.binding).unwrap();
    let mut cancellation = worker.cancellation();
    let original_revision = if original_phase == "succeeded" { 5 } else { 2 };
    let client = Client::restore(
        Racing {
            context: authority.context.clone(),
            started: tokio::sync::Semaphore::new(0),
            cancelled: tokio::sync::Semaphore::new(0),
            requests: Mutex::new(Vec::new()),
            original: response(
                &authority,
                Some(&prepared.control),
                original_phase,
                original_revision,
            ),
            cancel: cancel_phase.map_or(Err(lost()), |phase| {
                Ok(response(&authority, Some(&prepared.control), phase, 4))
            }),
            drained: AtomicBool::new(false),
        },
        authority,
        Platform::Posix,
    )
    .unwrap();
    let request = async {
        if status {
            service
                .recover_cancellable(&ready, &client, |_| Ok(()), &mut cancellation)
                .await
        } else {
            service
                .submit_cancellable(&ready, &prepared, &client, |_| Ok(()), &mut cancellation)
                .await
        }
    };
    let cancel = async {
        client
            .test_transport()
            .started
            .acquire()
            .await
            .unwrap()
            .forget();
        service.request_save_cancel(&ready.binding).unwrap();
    };
    let (result, ()) = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        tokio::join!(request, cancel)
    })
    .await
    .unwrap();
    assert!(client.test_transport().drained.load(Ordering::Acquire));
    let record = service.records().await.unwrap().pop().unwrap();
    assert!(secrets.load(&record.secret_key()).is_ok());
    if let Ok(result) = &result {
        assert!(*result == record);
    }
    let requests = client.test_transport().requests.lock().unwrap().clone();
    (record, requests, result.is_ok())
}

#[tokio::test]
async fn cancel_while_submit_reply_is_pending_drains_it_and_persists_newer_receipt_once() {
    let (record, requests, ok) = race("prepared", Some("cancelled"), false).await;
    assert!(ok);
    assert_eq!(requests, ["submit", "cancel"]);
    assert!(record.observation.as_ref().unwrap().phase == Phase::Cancelled);
    assert_eq!(record.observation.unwrap().revision, 4);
}
#[tokio::test]
async fn cancel_while_status_reply_is_pending_keeps_a_single_journal_writer() {
    let (record, requests, ok) = race("running", Some("cancelled"), true).await;
    assert!(ok);
    assert_eq!(requests, ["status", "cancel"]);
    assert!(record.observation.unwrap().phase == Phase::Cancelled);
}
#[tokio::test]
async fn a_later_published_original_reply_wins_over_cancel_and_cannot_be_rolled_back() {
    let (record, _, ok) = race("succeeded", Some("publishing"), false).await;
    assert!(ok);
    let receipt = record.observation.unwrap();
    assert!(receipt.phase == Phase::Succeeded);
    assert!(receipt.publication == Publication::Published);
    assert_eq!(receipt.revision, 5);
}
#[tokio::test]
async fn lost_cancel_reply_retains_unknown_and_credentials_without_resubmit() {
    let (record, requests, ok) = race("running", None, false).await;
    assert!(!ok);
    assert!(record.stage == Stage::Dispatched);
    assert!(record.observation.is_none());
    assert!(record.blocks_target());
    assert_eq!(requests, ["submit", "cancel"]);
}
#[tokio::test]
async fn cancellation_requires_the_exact_live_owner_and_generation() {
    let fixture = Fixture::new();
    let service = fixture.service(MemorySecrets::default());
    let authority = authority();
    let prepared = prepared(&authority);
    let ready = service
        .reserve(binding(&authority, &prepared), &prepared)
        .await
        .unwrap();
    assert!(service.request_save_cancel(&ready.binding).is_err());
    let worker = service.observe_save(&ready.binding).unwrap();
    let mut changed = ready.binding.clone();
    changed.owner.generation = uuid::Uuid::new_v4().to_string();
    assert!(service.request_save_cancel(&changed).is_err());
    assert!(service.save_status(&ready.binding) == Some(false));
    service.request_save_cancel(&ready.binding).unwrap();
    assert!(service.save_status(&ready.binding) == Some(true));
    drop(worker);
    assert!(service.request_save_cancel(&ready.binding).is_err());
}
