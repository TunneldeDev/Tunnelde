use super::*;
fn row(auto_start: bool, auto_retry: bool) -> Snapshot {
    Snapshot {
        id: "rule".into(),
        revision: "v1".into(),
        options: Options {
            auto_start,
            auto_retry,
        },
        session: None,
        plugin_owned: false,
        stop_revision: (0, 0),
    }
}
#[test]
fn startup_is_opt_in_and_only_runs_once() {
    let now = Instant::now();
    let mut book = Book::default();
    assert!(book.poll(&[row(false, true)], 4, now).is_empty());
    assert!(book.poll(&[row(true, true)], 4, now).is_empty());
    let mut book = Book::default();
    assert_eq!(book.poll(&[row(true, false)], 4, now).len(), 1);
    assert!(book.poll(&[row(true, false)], 4, now).is_empty());
}
#[test]
fn startup_capacity_does_not_lose_queued_rules() {
    let now = Instant::now();
    let mut book = Book::default();
    let mut rows = vec![row(true, false), row(true, false)];
    rows[1].id = "second".into();
    let first = book.poll(&rows, 1, now);
    assert_eq!(first.len(), 1);
    let second = book.poll(&rows, 1, now);
    assert_eq!(second.len(), 1);
    assert_ne!(first[0].id, second[0].id);
}
#[test]
fn retry_backs_off_and_success_resets_it() {
    let now = Instant::now();
    let mut book = Book::default();
    let r = row(true, true);
    let first = book.poll(&[r], 4, now).pop().unwrap();
    let error = Err(AppError::validation("forward.bindFailed"));
    book.finish(&first, &error, None, now);
    assert_eq!(book.status("rule", "v1").phase, "retrying");
    assert!(book
        .poll(&[row(true, true)], 4, now + Duration::from_secs(1))
        .is_empty());
    let second = book
        .poll(&[row(true, true)], 4, now + Duration::from_secs(2))
        .pop()
        .unwrap();
    book.finish(&second, &error, None, now + Duration::from_secs(2));
    assert!(book
        .poll(&[row(true, true)], 4, now + Duration::from_secs(5))
        .is_empty());
    let third = book
        .poll(&[row(true, true)], 4, now + Duration::from_secs(6))
        .pop()
        .unwrap();
    book.finish(&third, &Ok(()), Some("session".into()), now);
    assert_eq!(book.status("rule", "v1").phase, "running");
    assert!(book.poll(&[row(true, true)], 4, now).is_empty());
    assert_eq!(
        book.poll(&[row(true, true)], 4, now + Duration::from_secs(2))
            .len(),
        1
    );
    assert_eq!(retry_delay(100), Duration::from_secs(60));
}
#[test]
fn credentials_and_trust_errors_require_attention_without_retrying() {
    let now = Instant::now();
    for message in [
        "ssh.authFailed",
        "ssh.passwordRequired",
        "ssh.keyLoad: bad key",
        "ssh.hostKeyChanged",
        "ssh.hostKeyUnknown",
    ] {
        let mut book = Book::default();
        let ticket = book.poll(&[row(true, true)], 1, now).pop().unwrap();
        book.finish(&ticket, &Err(AppError::Ssh(message.into())), None, now);
        assert_eq!(book.status("rule", "v1").phase, "needsAttention");
        assert!(book
            .poll(&[row(true, true)], 1, now + Duration::from_secs(120))
            .is_empty());
    }
}
#[test]
fn manual_start_arms_retry_without_auto_start() {
    let now = Instant::now();
    let mut book = Book::default();
    let r = row(false, true);
    let ticket = book.manual(&r);
    book.finish(&ticket, &Ok(()), Some("session".into()), now);
    assert!(book.poll(&[r], 1, now).is_empty());
    assert_eq!(
        book.poll(&[row(false, true)], 1, now + Duration::from_secs(2))
            .len(),
        1
    );
}
#[test]
fn manual_stop_before_scan_or_during_start_cancels_automatic_work() {
    let now = Instant::now();
    let mut book = Book::default();
    book.pause("rule");
    assert!(book.poll(&[row(true, true)], 1, now).is_empty());
    let ticket = book.manual(&row(true, true));
    book.pause("rule");
    assert!(*ticket.cancelled.borrow());
    assert!(book.check(&ticket).is_err());
    book.finish(&ticket, &Ok(()), Some("session".into()), now);
    assert!(book
        .poll(&[row(true, true)], 1, now + Duration::from_secs(120))
        .is_empty());
}
#[test]
fn edits_deletions_and_external_stops_cancel_prepared_jobs() {
    let now = Instant::now();
    for mode in ["edit", "delete", "stop", "plugin"] {
        let mut book = Book::default();
        let ticket = book.poll(&[row(true, true)], 1, now).pop().unwrap();
        let mut changed = row(true, true);
        match mode {
            "edit" => changed.revision = "v2".into(),
            "stop" => changed.stop_revision.1 = 1,
            "plugin" => {
                changed.plugin_owned = true;
                changed.session = Some("plugin".into());
            }
            _ => {}
        }
        let rows = if mode == "delete" {
            vec![]
        } else {
            vec![changed]
        };
        assert!(book.poll(&rows, 1, now).is_empty());
        assert!(*ticket.cancelled.borrow());
        assert!(book.check(&ticket).is_err());
    }
}
#[test]
fn disconnect_pauses_recovery_and_no_retry_rules_return_to_idle() {
    let now = Instant::now();
    let mut book = Book::default();
    let ticket = book.manual(&row(false, true));
    book.finish(&ticket, &Ok(()), Some("session".into()), now);
    book.pause_session("session");
    assert!(book
        .poll(&[row(false, true)], 1, now + Duration::from_secs(120))
        .is_empty());
    let ticket = book.manual(&row(false, false));
    book.finish(&ticket, &Ok(()), Some("session".into()), now);
    assert!(book.poll(&[row(false, false)], 1, now).is_empty());
    assert_eq!(book.status("rule", "v1").phase, "idle");
}
