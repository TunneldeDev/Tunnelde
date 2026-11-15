use super::{queue::Queue, Action};

#[test]
fn queued_action_survives_cold_start_but_abandoned_confirmation_does_not_replay() {
    let mut q = Queue::default();
    q.submit(Action::Quit);
    assert!(q.take_delivery().is_none());
    q.reset();
    q.claim("first".into());
    let request = q.take_delivery().unwrap();
    assert!(matches!(request.action, Action::Quit));
    assert!(q.take_delivery().is_none());
    q.release("first");
    q.claim("next".into());
    assert!(q.take_delivery().is_none());
    assert!(q.begin("first", &request.id).is_err());
    assert!(q.begin("next", &request.id).is_err());
}

#[test]
fn stale_documents_and_superseded_dialogs_cannot_finish_or_release_current_request() {
    let mut q = Queue::default();
    q.claim("current".into());
    q.submit(Action::Quit);
    let old = q.take_delivery().unwrap();
    q.submit(Action::Restart);
    let current = q.take_delivery().unwrap();
    assert_ne!(old.id, current.id);
    q.release("old-document");
    assert!(q.begin("current", &old.id).is_err());
    assert!(q.begin("old-document", &current.id).is_err());
    assert!(matches!(
        q.begin("current", &current.id).unwrap(),
        Action::Restart
    ));
    assert!(q.begin("current", &current.id).is_err());
    // An accepted shutdown is not superseded by another menu click.
    q.submit(Action::Quit);
    assert!(q.take_delivery().is_none());
    q.failed(&current.id);
    assert!(matches!(
        q.begin("current", &current.id).unwrap(),
        Action::Restart
    ));
}

#[test]
fn delivery_failure_retains_only_the_matching_request() {
    let mut q = Queue::default();
    q.claim("current".into());
    q.submit(Action::Restart);
    let failed = q.take_delivery().unwrap();
    q.delivery_failed(&failed);
    assert_eq!(q.take_delivery().unwrap().id, failed.id);
    q.submit(Action::Quit);
    let newer = q.take_delivery().unwrap();
    q.delivery_failed(&failed);
    assert!(q.take_delivery().is_none());
    assert!(matches!(
        q.begin("current", &newer.id).unwrap(),
        Action::Quit
    ));
}
