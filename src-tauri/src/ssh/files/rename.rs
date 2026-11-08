use super::*;
use russh_sftp::client::error::Error;

/// A generic SFTP failure is not proof of EXDEV. Never turn it into a
/// copy-and-delete retry: it may instead mean a collision or lost reply.
pub(super) async fn entry(sftp: &SftpSession, from: &str, to: &str) -> AppResult<()> {
    sftp.rename(from, to)
        .await
        .map_err(|error| failure(from, to, error))
}

pub(super) fn failure(from: &str, to: &str, error: Error) -> AppError {
    let (status_code, server_message) = match &error {
        Error::Status(status) => (
            Some(status.status_code as u32),
            Some(status.error_message.clone()),
        ),
        _ => (None, None),
    };
    diagnostic(from, to, error.to_string(), status_code, server_message)
}

/// Preparation and connection failures may already have been converted to an
/// application error. Preserve validation/recovery errors and never log or
/// wrap an already contextualized rename twice.
pub(super) fn context(from: &str, to: &str, error: AppError) -> AppError {
    match error {
        AppError::Ssh(reason) if reason != CANCELLED => diagnostic(from, to, reason, None, None),
        error => error,
    }
}

fn diagnostic(
    from: &str,
    to: &str,
    reason: String,
    status_code: Option<u32>,
    server_message: Option<String>,
) -> AppError {
    tracing::warn!(
        operation = "rename",
        source = from,
        destination = to,
        status_code,
        server_message,
        %reason,
        "remote file move/rename failed"
    );
    AppError::RemoteRename {
        from: from.to_owned(),
        to: to.to_owned(),
        reason,
        status_code,
        server_message,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use russh_sftp::protocol::Status;
    use std::sync::Mutex;

    struct Server {
        result: StatusCode,
        calls: Arc<Mutex<Vec<(String, String)>>>,
    }

    impl russh_sftp::server::Handler for Server {
        type Error = StatusCode;

        fn unimplemented(&self) -> StatusCode {
            StatusCode::OpUnsupported
        }

        async fn rename(
            &mut self,
            id: u32,
            from: String,
            to: String,
        ) -> Result<Status, StatusCode> {
            self.calls.lock().unwrap().push((from, to));
            if self.result != StatusCode::Ok {
                return Err(self.result);
            }
            Ok(Status {
                id,
                status_code: StatusCode::Ok,
                error_message: String::new(),
                language_tag: String::new(),
            })
        }
    }

    #[tokio::test]
    async fn remote_rename_reports_real_protocol_status_and_paths_without_retry() {
        for status_code in [
            StatusCode::Ok,
            StatusCode::Failure,
            StatusCode::PermissionDenied,
        ] {
            let calls = Arc::new(Mutex::new(Vec::new()));
            let (client, server) = tokio::io::duplex(8192);
            russh_sftp::server::run(
                server,
                Server {
                    result: status_code,
                    calls: calls.clone(),
                },
            )
            .await;
            let sftp = SftpSession::new(client).await.unwrap();
            let from = "/原目录/a ' b.json";
            let to = "/挂载目录/a ' b.json";
            let result = entry(&sftp, from, to).await;
            if status_code == StatusCode::Ok {
                result.unwrap();
            } else {
                let error = serde_json::to_value(result.unwrap_err()).unwrap();
                assert_eq!(error["code"], "ssh");
                assert_eq!(error["details"]["operation"], "rename");
                assert_eq!(error["details"]["from"], from);
                assert_eq!(error["details"]["to"], to);
                assert_eq!(error["details"]["statusCode"], status_code as u32);
                assert_eq!(error["details"]["serverMessage"], status_code.to_string());
                assert!(error["message"].as_str().unwrap().contains(from));
                assert!(error["message"]
                    .as_str()
                    .unwrap()
                    .starts_with("sftp.error:"));
            }
            assert_eq!(
                *calls.lock().unwrap(),
                vec![(from.to_owned(), to.to_owned())]
            );
            sftp.close().await.unwrap();
        }
    }

    #[test]
    fn remote_rename_preserves_specific_server_and_transport_reasons() {
        for (cause, code, server_message, reason) in [
            (
                Error::Status(Status {
                    id: 1,
                    status_code: StatusCode::Failure,
                    error_message: "Invalid cross-device link".into(),
                    language_tag: String::new(),
                }),
                Some(4),
                Some("Invalid cross-device link"),
                "Invalid cross-device link",
            ),
            (Error::Timeout, None, None, "Timeout"),
            (
                Error::IO("connection reset".into()),
                None,
                None,
                "connection reset",
            ),
        ] {
            let error = serde_json::to_value(failure("/source", "/target", cause)).unwrap();
            assert_eq!(error["details"]["statusCode"], serde_json::json!(code));
            assert_eq!(
                error["details"]["serverMessage"],
                serde_json::json!(server_message)
            );
            assert!(error["details"]["reason"]
                .as_str()
                .unwrap()
                .contains(reason));
        }
    }

    #[test]
    fn remote_rename_preparation_keeps_paths_without_hiding_validation_or_recovery() {
        let error = context(
            "/source",
            "/target",
            AppError::Ssh("sftp.error: Failure: Failure".into()),
        );
        let serialized = serde_json::to_value(context("/other", "/new", error)).unwrap();
        assert_eq!(serialized["details"]["from"], "/source");
        assert_eq!(serialized["details"]["to"], "/target");
        assert_eq!(serialized["details"]["statusCode"], serde_json::Value::Null);
        assert_eq!(
            serialized["details"]["reason"],
            "sftp.error: Failure: Failure"
        );
        let error = context(
            "/source",
            "/target",
            AppError::validation("sftp.alreadyExists"),
        );
        assert_eq!(error.to_string(), "sftp.alreadyExists");
        assert_eq!(error.code(), "validation");
        assert_eq!(
            context("/source", "/target", AppError::Ssh(CANCELLED.into())).to_string(),
            CANCELLED
        );
        let error = context(
            "/source",
            "/target",
            AppError::BackupRecovery {
                backup: "/backup".into(),
                destination: "/target".into(),
            },
        );
        assert!(matches!(error, AppError::BackupRecovery { .. }));
    }
}
