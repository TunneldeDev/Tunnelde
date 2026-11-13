//! Real console and desktop CLI processes, using a fixed v1 wire consumer fixture.
use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Write},
    net::TcpListener,
    process::{Command, Output},
};

fn run(binary: &str, args: &[&str]) -> Output {
    let mut command = Command::new(binary);
    command.args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    command.output().unwrap()
}

#[test]
fn installed_binary_cli_and_console_cli_support_offline_and_error_exit_contracts() {
    for (binary, prefix) in [
        (env!("CARGO_BIN_EXE_tunnelde-cli"), Vec::<&str>::new()),
        (env!("CARGO_BIN_EXE_tunnelde"), vec!["cli"]),
    ] {
        let args: Vec<_> = prefix.iter().copied().chain(["--version"]).collect();
        let version = run(binary, &args);
        assert!(
            version.status.success(),
            "{}",
            String::from_utf8_lossy(&version.stderr)
        );
        assert_eq!(
            serde_json::from_slice::<Value>(&version.stdout).unwrap()["apiVersion"],
            1
        );
        assert!(version.stderr.is_empty());
        let args: Vec<_> = prefix.iter().copied().chain(["api", "describe"]).collect();
        let describe = run(binary, &args);
        assert!(describe.status.success());
        let discovery: Value = serde_json::from_slice(&describe.stdout).unwrap();
        let floor: Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/local-api/candidate-v1.json"
        ))
        .unwrap();
        assert_eq!(discovery["version"], floor["version"]);
        assert_eq!(discovery["stability"], "stable");
        assert_eq!(discovery["transport"], floor["transport"]);
        for method in floor["methods"].as_array().unwrap() {
            let mut expected = method.clone();
            expected["stability"] = json!("stable");
            expected["since"] = json!("0.38.0-beta.1");
            if method["name"] == "api.describe" {
                expected["resultSchema"] = serde_json::from_str(include_str!(
                    "../../tests/fixtures/local-api/stable-v1/discovery.json"
                ))
                .unwrap();
            }
            assert!(discovery["methods"].as_array().unwrap().contains(&expected));
        }
        let args: Vec<_> = prefix
            .iter()
            .copied()
            .chain(["call", "bad/method"])
            .collect();
        let invalid = run(binary, &args);
        assert_eq!(invalid.status.code(), Some(2));
        assert!(invalid.stdout.is_empty());
        assert_eq!(
            serde_json::from_slice::<Value>(&invalid.stderr).unwrap()["error"]["code"],
            "invalid_arguments"
        );
    }
}

fn fixture_reply(binary: &str, prefix: &[&str], mut response: Value) -> (Output, Value) {
    let directory =
        std::env::temp_dir().join(format!("tunnelde-cli-consumer-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&directory).unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = directory.join("endpoint.json");
    let pointer = directory.join("automation.json");
    std::fs::write(
        &endpoint,
        serde_json::to_vec(
            &json!({"version":1,"address":listener.local_addr().unwrap(),"token":"a".repeat(64),"future":true}),
        )
        .unwrap(),
    )
    .unwrap();
    std::fs::write(
        &pointer,
        serde_json::to_vec(&json!({"endpoint":endpoint,"future":true})).unwrap(),
    )
    .unwrap();
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(std::time::Duration::from_secs(10)))
            .unwrap();
        let mut bytes = Vec::new();
        BufReader::new(&mut stream)
            .read_until(b'\n', &mut bytes)
            .unwrap();
        let request: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(request["version"], 1);
        assert_eq!(request["method"], "hosts.list");
        assert_eq!(request["token"], "a".repeat(64));
        if response["id"] == "$request" {
            response["id"] = request["id"].clone();
        }
        writeln!(stream, "{response}").unwrap();
        request
    });
    let args: Vec<_> = prefix
        .iter()
        .copied()
        .chain(["--endpoint", pointer.to_str().unwrap(), "hosts", "list"])
        .collect();
    let result = run(binary, &args);
    let request = server.join().unwrap();
    std::fs::remove_file(endpoint).unwrap();
    std::fs::remove_file(pointer).unwrap();
    std::fs::remove_dir(directory).unwrap();
    (result, request)
}

#[test]
fn actual_cli_process_uses_v1_endpoint_and_preserves_machine_readable_results() {
    let (result, _) = fixture_reply(
        env!("CARGO_BIN_EXE_tunnelde-cli"),
        &[],
        json!({
            "version":1,"id":"$request","result":{"hosts":[],"future":true},"metadata":{"future":true}
        }),
    );
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&result.stdout).unwrap()["result"],
        json!({"hosts":[],"future":true})
    );
    assert!(result.stderr.is_empty());
}

#[test]
fn installed_and_console_clients_validate_outcomes_and_preserve_host_failure_ids() {
    for (binary, prefix) in [
        (env!("CARGO_BIN_EXE_tunnelde-cli"), vec![]),
        (env!("CARGO_BIN_EXE_tunnelde"), vec!["cli"]),
    ] {
        for (response, exit, expected) in [
            (
                json!({"version":1,"id":"$request","error":{"code":"stale_revision","message":"changed","retryAfter":1},"future":true}),
                5,
                "stale_revision",
            ),
            (
                json!({"version":1,"id":"$request","error":{"code":"future_error","message":"failed"}}),
                1,
                "future_error",
            ),
            (
                json!({"version":1,"id":"$request","error":{"code":"internal","message":"failed"},"result":{}}),
                2,
                "invalid_response",
            ),
            (json!({"version":1,"id":"$request"}), 2, "invalid_response"),
            (
                json!({"version":2,"id":"$request","result":{}}),
                2,
                "invalid_response",
            ),
            (
                json!({"version":1,"id":"different-request","result":{}}),
                2,
                "invalid_response",
            ),
            (
                json!({"version":1,"id":"$request","error":{"code":1,"message":"failed"}}),
                2,
                "invalid_response",
            ),
        ] {
            let (result, request) = fixture_reply(binary, &prefix, response);
            assert_eq!(
                result.status.code(),
                Some(exit),
                "{}",
                String::from_utf8_lossy(&result.stderr)
            );
            assert!(result.stdout.is_empty());
            let output: Value = serde_json::from_slice(&result.stderr).unwrap();
            assert_eq!(output["error"]["code"], expected);
            if expected != "invalid_response" {
                assert_eq!(output["id"], request["id"]);
            } else {
                assert_eq!(output["id"], "");
            }
        }
    }
}
