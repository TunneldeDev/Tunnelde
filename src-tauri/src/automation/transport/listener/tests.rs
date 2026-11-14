use super::*;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::time::{timeout, Duration};

struct OwnedRequest(Arc<AtomicBool>);
impl Drop for OwnedRequest {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Release);
    }
}

#[tokio::test]
async fn shutdown_closes_the_listener_and_excludes_idle_and_active_requests() {
    let socket = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = socket.local_addr().unwrap();
    let (stop, stopped) = watch::channel(false);
    let calls = Arc::new(AtomicUsize::new(0));
    let dropped = Arc::new(AtomicBool::new(false));
    let ready = Arc::new(tokio::sync::Semaphore::new(0));
    let (count, released, started) = (calls.clone(), dropped.clone(), ready.clone());
    let mut server = tokio::spawn(serve(socket, stopped, move |mut stream| {
        let (count, released, started) = (count.clone(), released.clone(), started.clone());
        async move {
            let mut request = [0];
            stream.read_exact(&mut request).await?;
            count.fetch_add(1, Ordering::AcqRel);
            let _owned = OwnedRequest(released);
            started.add_permits(1);
            std::future::pending::<io::Result<()>>().await
        }
    }));
    let mut active = TcpStream::connect(address).await.unwrap();
    active.write_all(b"x").await.unwrap();
    timeout(Duration::from_secs(3), ready.acquire())
        .await
        .unwrap()
        .unwrap()
        .forget();
    let mut idle = TcpStream::connect(address).await.unwrap();
    stop.send_replace(true);
    let exit = timeout(Duration::from_secs(1), &mut server).await;
    if exit.is_err() {
        server.abort();
        let _ = server.await;
    }
    assert!(
        exit.is_ok(),
        "stopping discovery must also stop accepting requests"
    );
    exit.unwrap().unwrap().unwrap();
    timeout(Duration::from_secs(1), async {
        while !dropped.load(Ordering::Acquire) {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    for client in [&mut active, &mut idle] {
        let mut bytes = Vec::new();
        let result = timeout(Duration::from_secs(1), client.read_to_end(&mut bytes))
            .await
            .unwrap();
        assert!(result.is_ok() || result.unwrap_err().kind() == io::ErrorKind::ConnectionReset);
        assert!(bytes.is_empty());
    }
    assert!(TcpStream::connect(address).await.is_err());
    assert_eq!(calls.load(Ordering::Acquire), 1);
}

#[tokio::test]
async fn stopping_before_listener_poll_never_dispatches_a_queued_connection() {
    let socket = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = socket.local_addr().unwrap();
    let _client = TcpStream::connect(address).await.unwrap();
    let (stop, stopped) = watch::channel(false);
    stop.send_replace(true);
    let calls = Arc::new(AtomicUsize::new(0));
    let count = calls.clone();
    let mut server = tokio::spawn(serve(socket, stopped, move |_| {
        count.fetch_add(1, Ordering::AcqRel);
        async { Ok(()) }
    }));
    let exit = timeout(Duration::from_secs(1), &mut server).await;
    if exit.is_err() {
        server.abort();
        let _ = server.await;
    }
    assert!(
        exit.is_ok(),
        "an already stopped service must not accept queued work"
    );
    exit.unwrap().unwrap().unwrap();
    assert_eq!(calls.load(Ordering::Acquire), 0);
    assert!(TcpStream::connect(address).await.is_err());
}

#[tokio::test]
async fn capacity_is_bounded_and_completed_connections_release_their_slots() {
    let socket = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = socket.local_addr().unwrap();
    let (stop, stopped) = watch::channel(false);
    let (admitted, mut started) = tokio::sync::mpsc::unbounded_channel();
    let mut server = tokio::spawn(serve(socket, stopped, move |mut stream| {
        let admitted = admitted.clone();
        async move {
            admitted.send(()).unwrap();
            let mut request = [0];
            stream.read_exact(&mut request).await?;
            Ok(())
        }
    }));
    let result = timeout(Duration::from_secs(3), async {
        let mut clients = Vec::new();
        for _ in 0..MAX_CONNECTIONS {
            clients.push(TcpStream::connect(address).await.unwrap());
            assert!(started.recv().await.is_some());
        }
        let mut rejected = TcpStream::connect(address).await.unwrap();
        let mut response = Vec::new();
        rejected.read_to_end(&mut response).await.unwrap();
        assert!(response.is_empty());
        assert!(started.try_recv().is_err());

        // Each completed request frees capacity for the next one while the
        // remaining seven connections are still held open.
        for _ in 0..MAX_CONNECTIONS + 2 {
            let mut completed = clients.remove(0);
            completed.write_all(b"x").await.unwrap();
            assert_eq!(completed.read(&mut [0]).await.unwrap(), 0);
            clients.push(TcpStream::connect(address).await.unwrap());
            assert!(started.recv().await.is_some());
        }
        stop.send_replace(true);
        (&mut server).await.unwrap().unwrap();
    })
    .await;
    if result.is_err() {
        server.abort();
        let _ = server.await;
    }
    assert!(result.is_ok(), "request slots must be bounded and reusable");
}

#[tokio::test]
async fn losing_the_lifecycle_owner_closes_the_listener() {
    let socket = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = socket.local_addr().unwrap();
    let (stop, stopped) = watch::channel(false);
    let mut server = tokio::spawn(serve(socket, stopped, |_| async { Ok(()) }));
    drop(stop);
    let exit = timeout(Duration::from_secs(1), &mut server).await;
    if exit.is_err() {
        server.abort();
        let _ = server.await;
    }
    assert!(exit.is_ok());
    exit.unwrap().unwrap().unwrap();
    assert!(TcpStream::connect(address).await.is_err());
}
