use super::*;

#[test]
fn parked_editor_retains_scope_and_only_current_revision_can_resume() {
    let fixture = Fixture::new();
    let mut journal = fixture.create();
    journal.enable_admission().unwrap();
    let original = journal
        .reserve_legacy(Kind::Editor, owner(), vec![scope("/workspace/file")])
        .unwrap();
    let permit = journal.dispatch_legacy(&original).unwrap();
    journal.park_editor_cleanup(permit).unwrap();
    drop(journal);
    let mut journal = Journal::open(&fixture.path()).unwrap();
    let parked = journal.legacy_claims().unwrap().remove(0);
    assert!(parked.phase == Phase::Recoverable);
    assert_eq!(parked.revision, 3);
    assert!(parked.owner == original.owner);
    assert!(native(&mut journal, "file/child").is_err());
    assert!(journal.retire_unsent_legacy(&parked).is_err());
    assert!(journal.dispatch_legacy(&original).is_err());
    let next = journal.dispatch_legacy(&parked).unwrap();
    assert_eq!(next.claim().revision, 4);
    assert!(journal.dispatch_legacy(&parked).is_err());
    journal.park_editor_cleanup(next).unwrap();
    let current = journal.legacy_claims().unwrap().remove(0);
    assert_eq!(current.revision, 5);
    assert!(journal.dispatch_legacy(&parked).is_err());
    let final_worker = journal.dispatch_legacy(&current).unwrap();
    journal.settle_legacy(final_worker).unwrap();
    native(&mut journal, "file").unwrap();
}

#[test]
fn independent_connections_race_owned_continuation_with_one_winner() {
    let fixture = Fixture::new();
    let mut journal = fixture.create();
    journal.enable_admission().unwrap();
    let original = journal
        .reserve_legacy(Kind::Editor, owner(), vec![scope("/workspace/file")])
        .unwrap();
    let dispatched = journal.dispatch_legacy(&original).unwrap();
    journal.park_editor_cleanup(dispatched).unwrap();
    let parked = journal.legacy_claims().unwrap().remove(0);
    drop(journal);
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let workers: Vec<_> = (0..2)
        .map(|_| {
            let path = fixture.path();
            let barrier = barrier.clone();
            let parked = parked.clone();
            std::thread::spawn(move || {
                let mut journal = Journal::open(&path).unwrap();
                barrier.wait();
                journal.dispatch_legacy(&parked)
            })
        })
        .collect();
    let results: Vec<_> = workers
        .into_iter()
        .map(|worker| worker.join().unwrap())
        .collect();
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    let mut journal = Journal::open(&fixture.path()).unwrap();
    assert!(journal.legacy_claims().unwrap()[0].phase == Phase::Dispatched);
    assert!(native(&mut journal, "file").is_err());
}
