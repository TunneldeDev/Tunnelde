use super::*;
use std::sync::atomic::{AtomicBool, Ordering};

#[tokio::test]
async fn revoked_owner_never_polls_new_mutation_but_finishes_admitted_close() {
    let authorized = Arc::new(AtomicBool::new(true));
    let observed = MutationObservation::default();
    let gate = authorized.clone();
    let dispatch = Dispatch::new(
        move || {
            if gate.load(Ordering::SeqCst) {
                Ok(())
            } else {
                Err(AppError::validation("revoked"))
            }
        },
        observed,
    );
    dispatch.request(async { Ok(()) }).await.unwrap();
    authorized.store(false, Ordering::SeqCst);
    assert_eq!(
        dispatch
            .request::<()>(async { panic!("revoked mutation was polled") })
            .await
            .unwrap_err()
            .to_string(),
        "revoked"
    );
    assert_eq!(
        dispatch
            .opaque::<()>(async { panic!("revoked replacement was polled") })
            .await
            .unwrap_err()
            .to_string(),
        "revoked"
    );
    let closed = Arc::new(AtomicBool::new(false));
    dispatch
        .close(async {
            closed.store(true, Ordering::SeqCst);
            Ok(())
        })
        .await
        .unwrap();
    assert!(closed.load(Ordering::SeqCst));
}
