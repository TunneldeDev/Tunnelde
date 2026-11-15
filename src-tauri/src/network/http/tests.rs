use super::*;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[tokio::test(flavor = "current_thread")]
async fn slow_preparation_leaves_the_runtime_responsive_and_preserves_errors() {
    let owner = std::thread::current().id();
    let (started, ready) = tokio::sync::oneshot::channel();
    let (release, wait) = std::sync::mpsc::channel();
    let preparation = tokio::spawn(acquire(move || -> AppResult<Prepared> {
        started.send(std::thread::current().id()).unwrap();
        wait.recv_timeout(Duration::from_secs(5)).unwrap();
        Err(AppError::Ssh(
            "vault.load: controlled platform failure".into(),
        ))
    }));
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
    let error = preparation.await.unwrap().err().unwrap();
    assert_eq!(error.to_string(), "vault.load: controlled platform failure");
}

#[tokio::test(flavor = "current_thread")]
async fn dropping_preparation_does_not_start_a_late_https_request() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let proxy = format!("http://{}", listener.local_addr().unwrap());
    let (started, ready) = tokio::sync::oneshot::channel();
    let (release, wait) = std::sync::mpsc::channel();
    let (settled, done) = tokio::sync::oneshot::channel();
    let request = tokio::spawn(async move {
        let route = acquire(move || {
            started.send(()).unwrap();
            wait.recv_timeout(Duration::from_secs(5)).unwrap();
            let route = HttpClients::default().prepare("updates", Some(proxy));
            settled.send(()).unwrap();
            route
        })
        .await?;
        route
            .client()
            .get("https://example.invalid/latest.json")
            .send()
            .await
            .map_err(|_| AppError::validation("unexpected.request"))
    });
    ready.await.unwrap();
    request.abort();
    assert!(request.await.unwrap_err().is_cancelled());
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

#[test]
fn cache_reuses_explicit_routes_and_expires_system_routes() {
    let clients = HttpClients::default();
    clients.prepare("updates", Some(String::new())).unwrap();
    let old = Instant::now() - Duration::from_secs(60);
    clients
        .0
        .lock()
        .unwrap()
        .get_mut("updates")
        .unwrap()
        .created = old;
    clients.prepare("updates", Some(String::new())).unwrap();
    assert_eq!(clients.0.lock().unwrap()["updates"].created, old);
    clients.prepare("updates", None).unwrap();
    clients
        .0
        .lock()
        .unwrap()
        .get_mut("updates")
        .unwrap()
        .created = old;
    clients.prepare("updates", None).unwrap();
    assert!(clients.0.lock().unwrap()["updates"].created > old);
}

#[test]
fn credential_changes_partition_route_identity_and_never_reuse_a_direct_route() {
    let clients = HttpClients::default();
    let direct = clients.prepare("updates", Some(String::new())).unwrap();
    let first = clients
        .prepare("updates", Some("http://user:first@127.0.0.1:7890/".into()))
        .unwrap();
    let next = clients
        .prepare("updates", Some("http://user:next@127.0.0.1:7890/".into()))
        .unwrap();
    assert_ne!(direct.fingerprint(), first.fingerprint());
    assert_ne!(first.fingerprint(), next.fingerprint());
    assert_eq!(first.proxy(), Some("http://user:first@127.0.0.1:7890/"));
    // A previously prepared operation retains its route when a new check changes
    // the cache; it cannot silently inherit the newer password or direct mode.
    assert_eq!(direct.proxy(), Some(""));
    assert_eq!(
        clients
            .prepare("updates", first.proxy.clone())
            .unwrap()
            .fingerprint(),
        first.fingerprint()
    );
    assert!(clients
        .prepare("updates", Some("not a proxy URL".into()))
        .is_err());
}

#[tokio::test]
async fn prepared_clients_require_https_and_honor_the_selected_proxy() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let proxy = format!("http://{}", listener.local_addr().unwrap());
    let clients = Arc::new(HttpClients::default());
    let route = acquire(move || clients.prepare("updates", Some(proxy)))
        .await
        .unwrap();
    assert!(route
        .client()
        .get("http://example.invalid/latest.json")
        .send()
        .await
        .is_err());
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut header = Vec::new();
        while !header.ends_with(b"\r\n\r\n") {
            header.push(stream.read_u8().await.unwrap());
        }
        assert!(String::from_utf8(header)
            .unwrap()
            .starts_with("CONNECT example.invalid:443 "));
        stream
            .write_all(b"HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n")
            .await
            .unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(150), listener.accept())
                .await
                .is_err()
        );
    });
    assert!(route
        .client()
        .get("https://example.invalid/latest.json")
        .timeout(Duration::from_secs(2))
        .send()
        .await
        .is_err());
    tokio::time::timeout(Duration::from_secs(3), server)
        .await
        .unwrap()
        .unwrap();
}
