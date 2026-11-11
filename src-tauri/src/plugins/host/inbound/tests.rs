use super::*;
use crate::error::{AppError, AppResult};
use crate::plugins::host::{bounded_line, error_payload};
use serde_json::json;
use std::{path::PathBuf, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncWriteExt, BufReader},
    process::Command,
};

#[tokio::test]
#[ignore = "requires explicit TUNNELDE_TEST_NODE and TUNNELDE_TEST_CANCEL_SDK"]
async fn current_sdk_control_frames_cancel_native_owned_futures_and_preserve_next_reply() {
    let node = std::env::var("TUNNELDE_TEST_NODE").expect("explicit test Node");
    let sdk = std::env::var("TUNNELDE_TEST_CANCEL_SDK").expect("pinned SDK entry");
    let probe = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../tests/fixtures/plugin-compat/request-cancellation/probe.mjs");
    for mode in ["abort", "timeout", "close"] {
        let mut command = Command::new(&node);
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let mut child = command
            .arg(&probe)
            .arg(&sdk)
            .arg(mode)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let exchange = async {
            let mut input = child.stdin.take().unwrap();
            let mut output = BufReader::new(child.stdout.take().unwrap());
            let first: Value =
                serde_json::from_str(&bounded_line(&mut output, 4096).await.unwrap().unwrap())
                    .unwrap();
            assert_eq!(first["method"], "ui.confirm");
            let registry = Requests::default();
            let key = request_key(&first).unwrap();
            registry.reserve("stdio", &key).unwrap();
            let mut request = registry.claim("stdio", &key).unwrap();
            let pending = request.run(std::future::pending::<AppResult<()>>());
            tokio::pin!(pending);
            assert!(futures_util::poll!(&mut pending).is_pending());
            let cancel: Value =
                serde_json::from_str(&bounded_line(&mut output, 4096).await.unwrap().unwrap())
                    .unwrap();
            assert_eq!(
                cancel,
                json!({"jsonrpc":"2.0","method":"$/cancelRequest","params":{"id":first["id"]}})
            );
            assert!(cancellation(&cancel, &registry));
            assert_eq!(
                pending.await.unwrap_err().to_string(),
                "plugin.api.cancelled"
            );
            // The SDK has already rejected locally; its original response must
            // not complete the next call on this same bidirectional stream.
            if mode != "close" {
                input.write_all(format!("{}\n",json!({"jsonrpc":"2.0","id":first["id"],"error":error_payload(&AppError::validation("plugin.api.cancelled"))})).as_bytes()).await.unwrap();
                let next: Value =
                    serde_json::from_str(&bounded_line(&mut output, 4096).await.unwrap().unwrap())
                        .unwrap();
                assert_eq!(next["method"], "api.describe");
                assert_ne!(next["id"], first["id"]);
                input
                    .write_all(
                        format!(
                            "{}\n",
                            json!({"jsonrpc":"2.0","id":next["id"],"result":{"ready":true}})
                        )
                        .as_bytes(),
                    )
                    .await
                    .unwrap();
            }
            let result: Value =
                serde_json::from_str(&bounded_line(&mut output, 4096).await.unwrap().unwrap())
                    .unwrap();
            assert_eq!(result["qa"], true);
            assert_eq!(
                result["next"],
                if mode == "close" {
                    Value::Null
                } else {
                    json!({"ready":true})
                }
            );
            assert!(result["outcome"].as_str().unwrap().contains(match mode {
                "abort" => "fixture-cancelled",
                "timeout" => "timed out",
                _ => "closed",
            }));
            drop(input);
        };
        tokio::time::timeout(Duration::from_secs(15), exchange)
            .await
            .unwrap();
        assert!(tokio::time::timeout(Duration::from_secs(5), child.wait())
            .await
            .unwrap()
            .unwrap()
            .success());
    }
}
