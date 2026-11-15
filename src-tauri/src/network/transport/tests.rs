use super::*;
use tokio::net::TcpListener;

#[tokio::test(flavor = "current_thread")]
async fn slow_native_probe_preparation_keeps_the_runtime_responsive_and_preserves_errors() {
    let owner = std::thread::current().id();
    let (started, ready) = tokio::sync::oneshot::channel();
    let (release, wait) = std::sync::mpsc::channel();
    let probe = tokio::spawn(async move {
        probe_prepared(
            "127.0.0.1",
            22,
            prepare(move || {
                started.send(std::thread::current().id()).unwrap();
                wait.recv_timeout(Duration::from_secs(5)).unwrap();
                Err(AppError::Ssh("vault.load: controlled failure".into()))
            }),
            Duration::from_secs(5),
        )
        .await
    });
    let worker = tokio::time::timeout(Duration::from_secs(2), ready)
        .await
        .unwrap()
        .unwrap();
    assert_ne!(owner, worker);
    tokio::time::timeout(Duration::from_secs(1), async {
        tokio::task::yield_now().await;
        tokio::time::sleep(Duration::from_millis(1)).await;
    })
    .await
    .unwrap();
    release.send(()).unwrap();
    assert_eq!(
        probe.await.unwrap().unwrap_err().to_string(),
        "vault.load: controlled failure"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn native_probe_timeout_includes_preparation_and_cannot_connect_after_the_worker_finishes() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let (started, ready) = tokio::sync::oneshot::channel();
    let (release, wait) = std::sync::mpsc::channel();
    let (settled, done) = tokio::sync::oneshot::channel();
    let probe = tokio::spawn(async move {
        probe_prepared(
            "127.0.0.1",
            port,
            prepare(move || {
                started.send(()).unwrap();
                wait.recv_timeout(Duration::from_secs(5)).unwrap();
                settled.send(()).unwrap();
                Ok(TcpRoute(String::new()))
            }),
            Duration::from_millis(200),
        )
        .await
    });
    tokio::time::timeout(Duration::from_secs(2), ready)
        .await
        .unwrap()
        .unwrap();
    let result = tokio::time::timeout(Duration::from_secs(2), probe)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(result.unwrap_err().to_string(), "network.timeout");
    release.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(2), done)
        .await
        .unwrap()
        .unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(150), listener.accept())
            .await
            .is_err()
    );
}

#[tokio::test(flavor = "current_thread")]
async fn abandoning_a_native_probe_does_not_dial_after_a_late_credential_read() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let (started, ready) = tokio::sync::oneshot::channel();
    let (release, wait) = std::sync::mpsc::channel();
    let (settled, done) = tokio::sync::oneshot::channel();
    let probe = tokio::spawn(async move {
        probe_prepared(
            "127.0.0.1",
            port,
            prepare(move || {
                started.send(()).unwrap();
                wait.recv_timeout(Duration::from_secs(5)).unwrap();
                settled.send(()).unwrap();
                Ok(TcpRoute(String::new()))
            }),
            Duration::from_secs(5),
        )
        .await
    });
    tokio::time::timeout(Duration::from_secs(2), ready)
        .await
        .unwrap()
        .unwrap();
    probe.abort();
    assert!(probe.await.unwrap_err().is_cancelled());
    release.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(2), done)
        .await
        .unwrap()
        .unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(150), listener.accept())
            .await
            .is_err()
    );
}

#[tokio::test]
async fn native_probe_closes_the_selected_transport_without_application_payload() {
    use tokio::io::AsyncReadExt;
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        assert_eq!(stream.read(&mut [0]).await.unwrap(), 0);
    });
    probe_prepared(
        "127.0.0.1",
        port,
        async { Ok(TcpRoute(String::new())) },
        Duration::from_secs(2),
    )
    .await
    .unwrap();
    tokio::time::timeout(Duration::from_secs(2), server)
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn expired_native_probe_does_not_connect_even_when_preparation_is_ready() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let result = probe_prepared(
        "127.0.0.1",
        port,
        async { Ok(TcpRoute(String::new())) },
        Duration::ZERO,
    )
    .await;
    assert_eq!(result.unwrap_err().to_string(), "network.timeout");
    assert!(
        tokio::time::timeout(Duration::from_millis(50), listener.accept())
            .await
            .is_err()
    );
}
