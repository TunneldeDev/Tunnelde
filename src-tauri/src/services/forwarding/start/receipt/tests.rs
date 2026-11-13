use super::*;
fn input(id: usize) -> Input {
    Input {
        id: "rule".into(),
        revision: "v1".into(),
        request_id: uuid::Uuid::from_u128(id as u128).to_string(),
    }
}
#[test]
fn replay_conflict_and_one_prompt_are_atomic() {
    let now = Instant::now();
    let mut book = Book::default();
    book.insert(input(1), (), now, 10).unwrap();
    assert_eq!(
        book.replay(&input(1), now).unwrap().unwrap().phase,
        Phase::Consent
    );
    let mut changed = input(1);
    changed.revision = "v2".into();
    assert_eq!(
        book.replay(&changed, now).unwrap_err().to_string(),
        "forward.startReused"
    );
    assert_eq!(
        book.insert(input(2), (), now, 10).unwrap_err().to_string(),
        "forward.startBusy"
    );
    book.cancel(&input(1).request_id, now).unwrap();
    book.insert(input(2), (), now, 10).unwrap();
}
#[test]
fn cancel_and_expiry_signal_inflight_work_and_reject_late_commit() {
    let now = Instant::now();
    let mut book = Book::default();
    book.insert(input(1), (), now, 10).unwrap();
    let signal = book
        .get(&input(1).request_id, now)
        .unwrap()
        .cancel
        .subscribe();
    book.cancel(&input(1).request_id, now).unwrap();
    assert!(*signal.borrow());
    assert!(book
        .get(&input(1).request_id, now)
        .unwrap()
        .check(now)
        .is_err());
    book.insert(input(2), (), now, 10).unwrap();
    let end = now + REQUEST_BUDGET;
    assert_eq!(
        book.get(&input(2).request_id, end).unwrap().receipt.phase,
        Phase::Expired
    );
}
#[test]
fn admitted_request_is_terminal_cancel_does_not_stop_it() {
    let now = Instant::now();
    let mut book = Book::default();
    book.insert(input(1), (), now, 10).unwrap();
    book.get(&input(1).request_id, now)
        .unwrap()
        .finish(Phase::Running, None, now);
    assert_eq!(
        book.cancel(&input(1).request_id, now).unwrap().phase,
        Phase::Running
    );
    book.cancel_pending(now);
    assert_eq!(
        book.get(&input(1).request_id, now).unwrap().receipt.phase,
        Phase::Running
    );
}
#[test]
fn lost_ui_cannot_be_replaced_or_used_after_heartbeat_deadline() {
    let now = Instant::now();
    let mut book = Book::default();
    book.insert(input(1), (), now, 10).unwrap();
    book.get(&input(1).request_id, now).unwrap().receipt.phase = Phase::Credentials;
    book.claim("first-document", now)
        .unwrap()
        .authorize_ui("first-document", now)
        .unwrap();
    assert!(book.claim("reloaded-document", now).is_none());
    assert_eq!(
        book.get(&input(1).request_id, now).unwrap().receipt.phase,
        Phase::Cancelled
    );
    book.insert(input(2), (), now, 10).unwrap();
    book.get(&input(2).request_id, now).unwrap().receipt.phase = Phase::Credentials;
    book.claim("document", now).unwrap();
    assert!(book.claim("document", now + UI_BUDGET).is_none());
    assert_eq!(
        book.get(&input(2).request_id, now + UI_BUDGET)
            .unwrap()
            .receipt
            .phase,
        Phase::Expired
    );
}
#[test]
fn retention_is_finite_but_capacity_never_evicts_early_receipts() {
    let now = Instant::now();
    let mut book = Book::default();
    for index in 0..CAPACITY {
        book.insert(input(index), (), now, 10).unwrap();
        book.cancel(&input(index).request_id, now).unwrap();
    }
    assert_eq!(
        book.insert(input(1000), (), now, 10)
            .unwrap_err()
            .to_string(),
        "forward.startBusy"
    );
    assert!(book
        .replay(&input(1), now + RETENTION - Duration::from_millis(1))
        .unwrap()
        .is_some());
    assert!(book.replay(&input(1), now + RETENTION).unwrap().is_none());
    book.insert(input(1000), (), now + RETENTION, 10).unwrap();
}

#[test]
fn releasing_an_old_document_never_claims_or_cancels_an_unowned_request() {
    let now = Instant::now();
    let mut book = Book::default();
    book.insert(input(1), (), now, 10).unwrap();
    book.get(&input(1).request_id, now).unwrap().receipt.phase = Phase::Credentials;
    book.release_ui("old", now);
    assert_eq!(
        book.get(&input(1).request_id, now).unwrap().receipt.phase,
        Phase::Credentials
    );
    book.claim("new", now).unwrap();
    book.release_ui("old", now);
    book.get(&input(1).request_id, now)
        .unwrap()
        .authorize_ui("new", now)
        .unwrap();
    book.release_ui("new", now);
    assert_eq!(
        book.get(&input(1).request_id, now).unwrap().receipt.phase,
        Phase::Cancelled
    );
}
