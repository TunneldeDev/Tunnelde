use super::*;

#[tokio::test(flavor = "current_thread")]
async fn cancelling_during_client_preparation_does_not_start_the_download() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let proxy = format!("http://{}", listener.local_addr().unwrap());
    let cancelled = Arc::new(AtomicBool::new(false));
    let flag = cancelled.clone();
    let (started, ready) = tokio::sync::oneshot::channel();
    let (release, wait) = std::sync::mpsc::channel();
    let (settled, done) = tokio::sync::oneshot::channel();
    let download = tokio::spawn(async move {
        let client = prepare_download(
            &flag,
            crate::services::credentials::inspect(move || {
                started.send(()).unwrap();
                wait.recv_timeout(Duration::from_secs(5)).unwrap();
                let client = crate::network::http_client_for_proxy(Some(&proxy));
                settled.send(()).unwrap();
                client
            }),
        )
        .await?;
        request(
            &client,
            validate_url("https://example.invalid/plugin.zip")?,
            Duration::from_secs(2),
        )
        .await
        .map_err(network_error)
    });
    ready.await.unwrap();
    cancelled.store(true, Ordering::Relaxed);
    // Cancellation must finish before the platform read is allowed to settle.
    let error = tokio::time::timeout(Duration::from_secs(1), download)
        .await
        .unwrap()
        .unwrap()
        .unwrap_err();
    assert_eq!(error.to_string(), "market.cancelled");
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
async fn cancellation_wins_when_preparation_and_cancel_are_both_ready() {
    let cancelled = AtomicBool::new(true);
    let prepared = Arc::new(AtomicBool::new(false));
    let observed = prepared.clone();
    let error = prepare_download(&cancelled, async move {
        observed.store(true, Ordering::Relaxed);
        Ok(())
    })
    .await
    .unwrap_err();
    assert_eq!(error.to_string(), "market.cancelled");
    assert!(!prepared.load(Ordering::Relaxed));
}

#[tokio::test]
async fn cancellation_is_rechecked_after_preparation_returns() {
    let cancelled = AtomicBool::new(false);
    let error = prepare_download(&cancelled, async {
        cancelled.store(true, Ordering::Relaxed);
        Ok(())
    })
    .await
    .unwrap_err();
    assert_eq!(error.to_string(), "market.cancelled");
}

#[test]
fn accepts_only_explicit_https_without_credentials() {
    assert!(validate_url("https://plugins.example.org/index.json?version=1").is_ok());
    for value in [
        "https://",
        "http://example.org/a",
        "file:///a",
        "https://u:p@example.org/a",
        "https://example.org/a#fragment",
    ] {
        assert!(validate_url(value).is_err(), "{value}");
    }
}

#[test]
fn network_diagnostics_keep_causes_without_urls_or_tokens() {
    let result = diagnostic(
        r#"ConnectError("TLS UnknownIssuer", url: "https://user:secret@example.org/archive?token=secret", proxy: http://u:p@localhost:7890)"#,
    );
    assert!(result.contains("TLS UnknownIssuer"));
    assert!(!result.contains("secret"));
    assert!(!result.contains("u:p"));
    assert!(!result.contains("example.org"));
}
#[tokio::test]
async fn rustls_premature_tls_eof_retries_the_selected_proxy_without_direct_fallback() {
    interrupted_handshake_retries(false).await;
}

#[cfg(windows)]
#[tokio::test]
async fn native_premature_tls_eof_retries_the_selected_proxy_without_direct_fallback() {
    interrupted_handshake_retries(true).await;
}

async fn interrupted_handshake_retries(native: bool) {
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let proxy = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        for _ in 0..3 {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut header = Vec::new();
            while !header.ends_with(b"\r\n\r\n") {
                header.push(stream.read_u8().await.unwrap());
            }
            assert!(String::from_utf8_lossy(&header).starts_with("CONNECT archive.example:443 "));
            stream
                .write_all(b"HTTP/1.1 200 Connection established\r\n\r\n")
                .await
                .unwrap();
            let mut hello = [0; 8192];
            assert!(stream.read(&mut hello).await.unwrap() > 0);
            stream.shutdown().await.unwrap();
        }
    });
    // Exercise the precise Rustls EOF that the common GET retry recognizes.
    // Windows production uses Schannel, whose errors need not share wording.
    let builder = reqwest::Client::builder()
        .no_proxy()
        .proxy(reqwest::Proxy::all(&proxy).unwrap())
        .tls_backend_rustls();
    #[cfg(windows)]
    let builder = if native {
        builder.tls_backend_native()
    } else {
        builder
    };
    #[cfg(not(windows))]
    assert!(!native);
    let client = builder.build().unwrap();
    let error = tokio::time::timeout(
        Duration::from_secs(8),
        request(
            &client,
            validate_url("https://archive.example/plugin.zip").unwrap(),
            Duration::from_secs(2),
        ),
    )
    .await
    .unwrap()
    .unwrap_err();
    assert_eq!(network_error(error).to_string(), "market.tlsHandshake");
    server.await.unwrap();
}

#[tokio::test]
async fn rejected_proxy_authentication_is_never_retried() {
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let proxy = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut header = Vec::new();
        while !header.ends_with(b"\r\n\r\n") {
            header.push(stream.read_u8().await.unwrap());
        }
        stream
            .write_all(b"HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n")
            .await
            .unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(1200), listener.accept())
                .await
                .is_err()
        );
    });
    let client = crate::network::http_client_for_proxy(Some(&proxy)).unwrap();
    assert!(request(
        &client,
        validate_url("https://archive.example/plugin.zip").unwrap(),
        Duration::from_secs(2)
    )
    .await
    .is_err());
    server.await.unwrap();
}
