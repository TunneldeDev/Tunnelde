use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

#[test]
fn statistics_exclude_failures_and_keep_small_values() {
    let result = summarize(vec![Some(20), None, Some(40)], None);
    assert_eq!(result.median_ms, Some(30));
    assert_eq!(result.min_ms, Some(20));
    assert_eq!(result.max_ms, Some(40));
    assert_eq!(result.spread_ms, Some(20));
    assert_eq!(result.successful, 2);
    assert_eq!(result.attempts, 3);
    assert_eq!(result.quality, Quality::Unstable);
    let local = summarize(vec![Some(0)], None);
    assert_eq!(local.median_ms, Some(0));
    assert_eq!(local.spread_ms, None);
    let failed = summarize(vec![None, None, None], None);
    assert_eq!(failed.quality, Quality::Unreachable);
    assert_eq!(failed.min_ms, None);
    assert_eq!(failed.median_ms, None);
    for (ms, expected) in [
        (100, Quality::Fast),
        (101, Quality::Normal),
        (300, Quality::Normal),
        (301, Quality::Slow),
    ] {
        assert_eq!(summarize(vec![Some(ms); 3], None).quality, expected);
    }
}

#[tokio::test]
async fn retries_transient_failures_but_never_retries_proxy_authentication() {
    let calls = AtomicUsize::new(0);
    let result = measure(
        || async {
            if calls.fetch_add(1, Ordering::SeqCst) == 0 {
                Err(std::io::Error::from(std::io::ErrorKind::ConnectionRefused).into())
            } else {
                Ok(42)
            }
        },
        BUDGET,
    )
    .await
    .unwrap();
    assert_eq!(result.samples_ms, vec![None, Some(42), Some(42)]);
    assert_eq!(result.quality, Quality::Unstable);
    assert!(result.last_error.is_some());
    calls.store(0, Ordering::SeqCst);
    let error = measure(
        || async {
            calls.fetch_add(1, Ordering::SeqCst);
            Err(AppError::validation("network.proxyRejected"))
        },
        BUDGET,
    )
    .await
    .unwrap_err();
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(error.to_string(), "network.proxyRejected");
}

#[tokio::test]
async fn total_budget_bounds_all_samples_and_does_not_invent_unattempted_samples() {
    let result = measure(
        || async { std::future::pending::<AppResult<u64>>().await },
        Duration::from_millis(10),
    )
    .await
    .unwrap();
    assert_eq!(result.samples_ms, vec![None]);
    assert_eq!(result.attempts, 1);
    assert_eq!(result.quality, Quality::Unreachable);
    assert_eq!(result.last_error.unwrap().to_string(), "network.timeout");
}

#[tokio::test]
async fn actual_direct_connections_are_closed_without_sending_application_data() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move {
        for _ in 0..SAMPLES {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut byte = [0];
            assert_eq!(stream.read(&mut byte).await.unwrap(), 0);
        }
    });
    let result = measure_route("127.0.0.1", port, "").await.unwrap();
    assert_eq!(result.successful, 3);
    tokio::time::timeout(Duration::from_secs(2), server)
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn actual_http_proxy_measurements_include_negotiation_and_preserve_selected_route() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move {
        for _ in 0..SAMPLES {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut header = Vec::new();
            while !header.ends_with(b"\r\n\r\n") {
                header.push(stream.read_u8().await.unwrap());
            }
            assert!(String::from_utf8(header)
                .unwrap()
                .starts_with("CONNECT unreachable.invalid:443 HTTP/1.1\r\n"));
            tokio::time::sleep(Duration::from_millis(20)).await;
            stream
                .write_all(b"HTTP/1.1 200 Connection established\r\n\r\n")
                .await
                .unwrap();
            assert_eq!(
                stream.read_u8().await.unwrap_err().kind(),
                std::io::ErrorKind::UnexpectedEof
            );
        }
    });
    let result = measure_route(
        "unreachable.invalid",
        443,
        &format!("http://127.0.0.1:{port}"),
    )
    .await
    .unwrap();
    assert_eq!(result.successful, 3);
    assert!(result.min_ms.unwrap() >= 15);
    tokio::time::timeout(Duration::from_secs(2), server)
        .await
        .unwrap()
        .unwrap();
    let json = serde_json::to_value(result).unwrap();
    assert!(json["samplesMs"].is_array());
    assert!(json["medianMs"].is_u64());
}

#[tokio::test]
#[ignore = "opt-in TCP-only measurement against an explicitly selected endpoint"]
async fn live_tcp_quality() {
    let host = std::env::var("TUNNELDE_TCP_TEST_HOST").unwrap();
    let port = std::env::var("TUNNELDE_TCP_TEST_PORT")
        .unwrap()
        .parse()
        .unwrap();
    let result = measure_route(&host, port, "").await.unwrap();
    println!("{}", serde_json::to_string_pretty(&result).unwrap());
    assert_eq!(result.successful, 3);
}

#[tokio::test]
async fn tcp_success_does_not_imply_https_success() {
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let proxy = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        for attempt in 0..4 {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut header = Vec::new();
            while !header.ends_with(b"\r\n\r\n") {
                header.push(stream.read_u8().await.unwrap());
            }
            stream
                .write_all(b"HTTP/1.1 200 Connection established\r\n\r\n")
                .await
                .unwrap();
            if attempt == 3 {
                let mut hello = [0; 8192];
                let _ = stream.read(&mut hello).await;
            }
        }
    });
    let tcp = measure_route("archive.example", 443, &proxy).await.unwrap();
    assert_eq!(tcp.successful, 3);
    let https = check_https("archive.example", &proxy).await;
    assert!(!https.success);
    assert_eq!(https.error.unwrap().to_string(), "network.httpsFailed");
    server.await.unwrap();
}
