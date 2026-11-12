use super::*;
use serde_json::json;
use std::sync::atomic::{AtomicUsize, Ordering};

async fn wire(bytes: Vec<u8>, calls: Arc<AtomicUsize>) -> Response {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        connection(stream, &"a".repeat(64), move |_| async move {
            calls.fetch_add(1, Ordering::SeqCst);
            Ok(json!({"value":"actual-local-wire"}))
        })
        .await
        .unwrap();
    });
    let mut client = TcpStream::connect(address).await.unwrap();
    client.write_all(&bytes).await.unwrap();
    client.shutdown().await.unwrap();
    let mut response = Vec::new();
    client.read_to_end(&mut response).await.unwrap();
    server.await.unwrap();
    serde_json::from_slice(&response).unwrap()
}
fn request(token: &str) -> Vec<u8> {
    let mut bytes = serde_json::to_vec(&Request {
        version: 1,
        id: "consumer".into(),
        token: token.into(),
        method: "app.info".into(),
        params: json!({}),
    })
    .unwrap();
    bytes.push(b'\n');
    bytes
}

#[tokio::test]
async fn real_loopback_authentication_rejects_before_domain_dispatch() {
    let calls = Arc::new(AtomicUsize::new(0));
    let response = wire(request(&"b".repeat(64)), calls.clone()).await;
    assert!(matches!(response.outcome, Outcome::Error { error } if error.code == "unauthorized"));
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    let response = wire(request(&"a".repeat(64)), calls.clone()).await;
    assert_eq!(response.id, "consumer");
    assert!(
        matches!(response.outcome, Outcome::Success { result } if result["value"] == "actual-local-wire")
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn malformed_and_unframed_inputs_cannot_dispatch() {
    let calls = Arc::new(AtomicUsize::new(0));
    for bytes in [
        b"not-json\n".to_vec(),
        b"{}".to_vec(),
        vec![b'x'; MAX_REQUEST + 1],
    ] {
        let response = wire(bytes, calls.clone()).await;
        assert!(
            matches!(response.outcome, Outcome::Error { error } if error.code == "invalid_request")
        );
    }
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[test]
fn private_registration_never_places_a_capability_in_the_public_pointer() {
    let data = std::env::temp_dir().join(format!("tunnelde-api-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&data).unwrap();
    let endpoint = Endpoint {
        version: 1,
        address: "127.0.0.1:12345".parse().unwrap(),
        token: "a".repeat(64),
    };
    let registration = location::Registration::create(&data, &endpoint).unwrap();
    let pointer = data.join("automation.json");
    assert!(!std::fs::read_to_string(&pointer)
        .unwrap()
        .contains(&endpoint.token));
    assert_eq!(location::read(&pointer).unwrap().token, endpoint.token);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let value: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&pointer).unwrap()).unwrap();
        let directory = std::path::Path::new(value["endpoint"].as_str().unwrap())
            .parent()
            .unwrap();
        assert_eq!(
            std::fs::metadata(directory).unwrap().permissions().mode() & 0o777,
            0o700
        );
    }
    drop(registration);
    assert!(!pointer.exists());
    assert_eq!(std::fs::read_dir(&data).unwrap().count(), 0);
    std::fs::remove_dir(data).unwrap();
}
