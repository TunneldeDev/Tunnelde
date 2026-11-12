use super::*;
use russh_sftp::protocol::Status;

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
