use super::*;
use serde_json::json;
use std::{io::BufReader, net::TcpListener, thread, time::Instant};

fn fixture(
    action: impl FnOnce(TcpStream, Value) + Send + 'static,
) -> (TcpStream, thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        stream
            .set_write_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let mut bytes = Vec::new();
        BufReader::new(&mut stream)
            .read_until(b'\n', &mut bytes)
            .unwrap();
        action(stream, serde_json::from_slice(&bytes).unwrap());
    });
    (client, server)
}

#[test]
fn slow_partial_output_cannot_reset_the_absolute_client_deadline() {
    let (stream, server) = fixture(|mut stream, _| {
        // Every fragment arrives sooner than the inactivity timeout, but the
        // response as a whole exceeds the budget and never reaches a newline.
        for _ in 0..100 {
            if stream.write_all(b" ").is_err() {
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
    });
    let started = Instant::now();
    let error = exchange_stream(
        stream,
        "a".repeat(64),
        "app.info".into(),
        json!({}),
        Duration::from_millis(80),
    )
    .unwrap_err();
    assert_eq!(error.code, "timeout");
    assert_eq!(error.exit_code(), 3);
    assert!(started.elapsed() < Duration::from_secs(2));
    server.join().unwrap();
}

#[test]
fn fragmented_valid_response_preserves_request_identity_within_the_budget() {
    let (stream, server) = fixture(|mut stream, request| {
        let mut bytes = serde_json::to_vec(
            &json!({"version":1,"id":request["id"],"result":{"version":"test"}}),
        )
        .unwrap();
        bytes.push(b'\n');
        for chunk in bytes.chunks(7) {
            stream.write_all(chunk).unwrap();
        }
    });
    let response = exchange_stream(
        stream,
        "a".repeat(64),
        "app.info".into(),
        json!({}),
        Duration::from_secs(3),
    )
    .unwrap();
    assert!(matches!(response.outcome, Outcome::Success { result } if result["version"] == "test"));
    server.join().unwrap();
}

#[test]
fn zero_budget_never_sends_a_request() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
    let (mut server, _) = listener.accept().unwrap();
    let error = exchange_stream(
        client,
        "a".repeat(64),
        "app.info".into(),
        json!({}),
        Duration::ZERO,
    )
    .unwrap_err();
    assert_eq!(error.code, "timeout");
    let mut received = Vec::new();
    server.read_to_end(&mut received).unwrap();
    assert!(received.is_empty());
}

#[test]
fn closed_connection_is_unavailable_but_partial_unframed_output_is_invalid() {
    for (bytes, expected, exit) in [
        (b"".as_slice(), "unavailable", 3),
        (b"{}".as_slice(), "invalid_response", 2),
    ] {
        let (stream, server) = fixture(move |mut stream, _| {
            stream.write_all(bytes).unwrap();
        });
        let error = exchange_stream(
            stream,
            "a".repeat(64),
            "app.info".into(),
            json!({}),
            Duration::from_secs(3),
        )
        .unwrap_err();
        assert_eq!(error.code, expected);
        assert_eq!(error.exit_code(), exit);
        server.join().unwrap();
    }
}
