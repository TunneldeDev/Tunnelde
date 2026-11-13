use super::*;
use russh_sftp::protocol::Status;

#[tokio::test]
async fn sealed_epoch_rejects_new_work_without_polling_it() {
    let observation = Observation::default();
    let queued = observation.clone();
    observation.seal().unwrap();
    assert!(observation.settled());
    let polled = std::sync::atomic::AtomicBool::new(false);
    let result = queued
        .request(async {
            polled.store(true, Ordering::Release);
            Ok(())
        })
        .await;
    assert!(result.is_err());
    assert!(queued
        .opaque(async {
            polled.store(true, Ordering::Release);
            Ok(())
        })
        .await
        .is_err());
    assert!(!polled.load(Ordering::Acquire));
    assert!(queued.begin().is_none());
    assert!(queued.seal().is_err(), "one epoch can be sealed only once");
}

#[test]
fn pending_original_receipt_blocks_sealing_until_its_own_acknowledgement() {
    let observation = Observation::default();
    let receipt = observation.begin().unwrap();
    assert!(observation.seal().is_err());
    assert!(!observation.settled());
    receipt.acknowledge();
    observation.seal().unwrap();
    assert!(observation.settled());
}

#[test]
fn concurrent_seal_and_request_admission_have_one_winner() {
    for _ in 0..64 {
        let observation = Observation::default();
        let barrier = Arc::new(std::sync::Barrier::new(2));
        let other = observation.clone();
        let other_barrier = barrier.clone();
        let worker = std::thread::spawn(move || {
            other_barrier.wait();
            other.begin()
        });
        barrier.wait();
        let sealed = observation.seal();
        let receipt = worker.join().unwrap();
        assert_ne!(sealed.is_ok(), receipt.is_some());
        if let Some(receipt) = receipt {
            receipt.acknowledge();
            observation.seal().unwrap();
        }
        assert!(observation.settled());
        assert!(observation.begin().is_none());
    }
}

fn status(code: StatusCode) -> Error {
    Error::Status(Status {
        id: 42,
        status_code: code,
        error_message: "same presentation for all causes".into(),
        language_tag: String::new(),
    })
}

#[tokio::test]
async fn only_original_typed_terminal_replies_acknowledge_a_request() {
    for code in [
        StatusCode::NoSuchFile,
        StatusCode::PermissionDenied,
        StatusCode::Failure,
        StatusCode::OpUnsupported,
    ] {
        let observation = Observation::default();
        let result: Result<(), Error> = observation.request(async { Err(status(code)) }).await;
        assert!(matches!(result, Err(Error::Status(_))));
        assert!(observation.settled());
    }
    for cause in [
        status(StatusCode::Ok),
        status(StatusCode::Eof),
        status(StatusCode::NoConnection),
        status(StatusCode::ConnectionLost),
        status(StatusCode::BadMessage),
        Error::Timeout,
        Error::UnexpectedPacket,
        Error::IO("Failure: Failure".into()),
    ] {
        let observation = Observation::default();
        let result: Result<(), Error> = observation.request(async { Err(cause) }).await;
        assert!(result.is_err());
        assert!(!observation.settled());
        // An unrelated success cannot erase the unresolved request.
        observation.request(async { Ok(()) }).await.unwrap();
        assert!(!observation.settled());
    }
}

#[tokio::test]
async fn dropped_request_and_string_lookalikes_never_create_completion_evidence() {
    let observation = Observation::default();
    let mut pending = Box::pin(observation.request(std::future::pending::<Result<(), Error>>()));
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(1), &mut pending)
            .await
            .is_err()
    );
    assert!(!observation.settled());
    drop(pending);
    let result: AppResult<()> = observation
        .opaque(async {
            Err(crate::error::AppError::Ssh(
                "sftp.error: Failure: Failure".into(),
            ))
        })
        .await;
    assert!(result.is_err());
    observation.opaque(async { Ok(()) }).await.unwrap();
    assert!(!observation.settled());
}
