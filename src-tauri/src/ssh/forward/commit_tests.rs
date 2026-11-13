//! Final admission must reject a stale/duplicate preparation before a caller
//! can transfer ownership of its private resources in the commit callback.
use super::*;
use std::{net::SocketAddr, sync::atomic::AtomicUsize};

async fn pending(
    registry: &ForwardRegistry,
    id: &str,
) -> (
    PendingForward,
    SocketAddr,
    Arc<AtomicBool>,
    watch::Receiver<bool>,
) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let admitted = Arc::new(AtomicBool::new(false));
    let (cancel, cancelled) = watch::channel(false);
    let item = ActiveForward {
        admitted: admitted.clone(),
        identity: uuid::Uuid::new_v4().to_string(),
        session: "session".into(),
        owner: None,
        generation: None,
        cancel,
        listener: Some(tokio::spawn(async move {
            let _listener = listener;
            std::future::pending::<()>().await;
        })),
        remote: None,
    };
    (
        PendingForward {
            id: id.into(),
            ticket: registry.ticket(id, "session").unwrap(),
            item,
        },
        address,
        admitted,
        cancelled,
    )
}

async fn released(address: SocketAddr, mut cancelled: watch::Receiver<bool>) {
    tokio::time::timeout(Duration::from_secs(3), async {
        if !*cancelled.borrow_and_update() {
            cancelled.changed().await.unwrap();
        }
        assert!(*cancelled.borrow());
        loop {
            if let Ok(listener) = TcpListener::bind(address).await {
                drop(listener);
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("rejected pending listener was not released");
}

#[tokio::test]
async fn duplicate_preparation_never_runs_publication_callback_or_displaces_winner() {
    let registry = ForwardRegistry::default();
    let publications = AtomicUsize::new(0);
    let (winner, winner_address, winner_admitted, winner_cancelled) =
        pending(&registry, "rule").await;
    let winner_identity = winner.item.identity.clone();
    let (loser, loser_address, loser_admitted, loser_cancelled) = pending(&registry, "rule").await;
    winner
        .commit(&registry, || {
            publications.fetch_add(1, Ordering::SeqCst);
            Ok(())
        })
        .unwrap();
    let error = loser
        .commit(&registry, || {
            publications.fetch_add(1, Ordering::SeqCst);
            Ok(())
        })
        .unwrap_err();
    assert!(matches!(error, AppError::Validation(ref reason) if reason == "forward.alreadyActive"));
    assert_eq!(
        publications.load(Ordering::SeqCst),
        1,
        "duplicate preparation ran a resource-publication callback"
    );
    assert!(!loser_admitted.load(Ordering::Acquire));
    released(loser_address, loser_cancelled).await;
    assert_eq!(registry.snapshot().unwrap()["rule"].1, winner_identity);
    assert!(winner_admitted.load(Ordering::Acquire));
    assert!(TcpListener::bind(winner_address).await.is_err());
    assert!(!*winner_cancelled.borrow());
    registry.stop("rule").await.unwrap();
    released(winner_address, winner_cancelled).await;
}

#[tokio::test]
async fn cancelled_preparation_skips_publication_and_disposes_listener() {
    let registry = ForwardRegistry::default();
    let (pending, address, admitted, cancelled) = pending(&registry, "rule").await;
    registry.stop("rule").await.unwrap();
    let publications = AtomicUsize::new(0);
    let error = pending
        .commit(&registry, || {
            publications.fetch_add(1, Ordering::SeqCst);
            Ok(())
        })
        .unwrap_err();
    assert!(
        matches!(error, AppError::Validation(ref reason) if reason == "forward.startCancelled")
    );
    assert_eq!(publications.load(Ordering::SeqCst), 0);
    assert!(!admitted.load(Ordering::Acquire));
    released(address, cancelled).await;
    assert!(registry.snapshot().unwrap().is_empty());
}

#[tokio::test]
async fn denied_final_authority_never_admits_or_retains_listener() {
    let registry = ForwardRegistry::default();
    let (pending, address, admitted, cancelled) = pending(&registry, "rule").await;
    let error = pending
        .commit(&registry, || Err(AppError::validation("revoked")))
        .unwrap_err();
    assert!(matches!(error, AppError::Validation(ref reason) if reason == "revoked"));
    assert!(!admitted.load(Ordering::Acquire));
    released(address, cancelled).await;
    assert!(registry.snapshot().unwrap().is_empty());
}
