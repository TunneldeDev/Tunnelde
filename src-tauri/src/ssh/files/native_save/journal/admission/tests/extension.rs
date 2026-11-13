use super::*;

fn transfer(journal: &mut Journal) -> Dispatched {
    let claim = journal
        .reserve_legacy(Kind::Transfer, owner(), vec![scope("/workspace/file")])
        .unwrap();
    journal.dispatch_legacy(&claim).unwrap()
}

#[test]
fn generated_paths_join_the_original_transfer_without_locking_unrelated_siblings() {
    let fixture = Fixture::new();
    let mut journal = fixture.create();
    journal.enable_admission().unwrap();
    let mut permit = transfer(&mut journal);
    let original = permit.claim().clone();
    let extended = journal
        .extend_transfer(
            &original,
            vec![
                scope("/workspace/.task-stage"),
                scope("/workspace/.task-backup"),
            ],
        )
        .unwrap();
    assert_eq!(extended.revision, 4);
    assert!(extended.owner == original.owner && extended.id == original.id);
    assert!(extended.phase == Phase::Dispatched);
    for path in ["file", ".task-stage/child", ".task-backup"] {
        assert!(
            matches!(native(&mut journal, path), Err(Error::Occupied)),
            "{path}"
        );
    }
    native(&mut journal, "unrelated").unwrap();
    assert!(journal
        .extend_transfer(&original, vec![scope("/workspace/.task-stage")])
        .is_err());
    assert!(
        journal
            .extend_transfer(&extended, vec![scope("/workspace/.task-stage")])
            .unwrap()
            == extended
    );
    permit.adopt_transfer_extension(extended).unwrap();
    journal.settle_legacy(permit).unwrap();
    native(&mut journal, ".task-stage").unwrap();
}

#[test]
fn conflict_or_changed_identity_never_discards_original_or_adds_partial_coverage() {
    let fixture = Fixture::new();
    let mut journal = fixture.create();
    journal.enable_admission().unwrap();
    let permit = transfer(&mut journal);
    let original = permit.claim().clone();
    native(&mut journal, "occupied").unwrap();
    assert!(matches!(
        journal.extend_transfer(
            &original,
            vec![scope("/workspace/new"), scope("/workspace/occupied")]
        ),
        Err(Error::Occupied)
    ));
    assert!(journal.legacy_claims().unwrap() == [original.clone()]);
    native(&mut journal, "new").unwrap();
    let mut alias = scope("/workspace/alias");
    alias.destination.host_id = "other-saved-host".into();
    assert!(journal.extend_transfer(&original, vec![alias]).is_err());
    let mut changed = original.clone();
    changed.owner.generation = uuid::Uuid::new_v4().to_string();
    assert!(journal
        .extend_transfer(&changed, vec![scope("/workspace/changed")])
        .is_err());
    assert!(journal.legacy_claims().unwrap() == [original]);
    journal.settle_legacy(permit).unwrap();
}

#[test]
fn expanding_transfer_and_native_reservation_have_one_transactional_winner() {
    for _ in 0..8 {
        let fixture = Fixture::new();
        let mut journal = fixture.create();
        journal.enable_admission().unwrap();
        let permit = transfer(&mut journal);
        let original = permit.claim().clone();
        drop(journal);
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let mut workers = Vec::new();
        for expanding in [false, true] {
            let barrier = barrier.clone();
            let path = fixture.path();
            let original = original.clone();
            workers.push(std::thread::spawn(move || {
                let mut journal = Journal::open(&path).unwrap();
                barrier.wait();
                if expanding {
                    journal
                        .extend_transfer(&original, vec![scope("/workspace/new-stage")])
                        .map(|_| ())
                } else {
                    native(&mut journal, "new-stage").map(|_| ())
                }
            }));
        }
        let results: Vec<_> = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect();
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(
            results
                .iter()
                .filter(|result| matches!(result, Err(Error::Occupied)))
                .count(),
            1
        );
        drop(permit); // Unknown/dispatched ownership survives loss of the worker.
        let mut journal = Journal::open(&fixture.path()).unwrap();
        assert!(matches!(native(&mut journal, "file"), Err(Error::Occupied)));
    }
}

#[test]
fn expansion_rejects_wrong_kind_invalid_paths_and_capacity_without_changing_original() {
    let fixture = Fixture::new();
    let mut journal = fixture.create();
    journal.enable_admission().unwrap();
    let original = journal
        .reserve_legacy(Kind::Editor, owner(), vec![scope("/workspace/editor")])
        .unwrap();
    let editor = journal.dispatch_legacy(&original).unwrap();
    assert!(journal
        .extend_transfer(editor.claim(), vec![scope("/workspace/extra")])
        .is_err());
    let permit = transfer(&mut journal);
    assert!(journal.extend_transfer(permit.claim(), vec![]).is_err());
    assert!(journal
        .extend_transfer(permit.claim(), vec![scope("relative")])
        .is_err());
    let mut large = scope("/workspace/new");
    large.paths = (0..32).map(|n| format!("/workspace/new-{n}")).collect();
    assert!(journal
        .extend_transfer(permit.claim(), vec![large])
        .is_err());
    assert!(journal
        .legacy_claims()
        .unwrap()
        .iter()
        .any(|claim| claim == permit.claim()));
    journal.settle_legacy(permit).unwrap();
    journal.settle_legacy(editor).unwrap();
}

#[test]
fn a_historical_or_forged_checkpoint_cannot_replace_a_live_dispatch_permit() {
    let fixture = Fixture::new();
    let mut journal = fixture.create();
    journal.enable_admission().unwrap();
    let mut permit = transfer(&mut journal);
    let original = permit.claim().clone();
    let extended = journal
        .extend_transfer(&original, vec![scope("/workspace/stage")])
        .unwrap();
    let mut forged = extended.clone();
    forged.owner.generation = uuid::Uuid::new_v4().to_string();
    assert!(permit.adopt_transfer_extension(forged).is_err());
    let mut narrowed = extended.clone();
    narrowed.scopes[0].paths.remove(0);
    assert!(permit.adopt_transfer_extension(narrowed).is_err());
    let mut promoted = extended.clone();
    promoted.transfer_roots = Some(promoted.scopes.clone());
    assert!(promoted.valid());
    assert!(permit.adopt_transfer_extension(promoted).is_err());
    let mut unbound = extended.clone();
    unbound.transfer_roots = None;
    assert!(unbound.valid(), "historical records remain readable");
    assert!(permit.adopt_transfer_extension(unbound).is_err());
    permit.adopt_transfer_extension(extended).unwrap();
    assert!(permit.adopt_transfer_extension(original).is_err());
    journal.settle_legacy(permit).unwrap();
}

#[test]
fn lost_extension_delivery_leaves_old_permit_stale_and_both_scopes_reserved() {
    let fixture = Fixture::new();
    let mut journal = fixture.create();
    journal.enable_admission().unwrap();
    let permit = transfer(&mut journal);
    journal
        .extend_transfer(permit.claim(), vec![scope("/workspace/stage")])
        .unwrap();
    assert!(journal.settle_legacy(permit).is_err());
    drop(journal);
    let mut journal = Journal::open(&fixture.path()).unwrap();
    for path in ["file", "stage"] {
        assert!(matches!(native(&mut journal, path), Err(Error::Occupied)));
    }
    let record = journal.legacy_claims().unwrap().remove(0);
    assert!(journal.dispatch_legacy(&record).is_err());
    assert!(journal.retire_unsent_legacy(&record).is_err());
}

#[test]
fn directory_children_use_existing_coverage_without_an_unbounded_path_inventory() {
    let fixture = Fixture::new();
    let mut journal = fixture.create();
    journal.enable_admission().unwrap();
    let prepared = journal
        .reserve_legacy(Kind::Transfer, owner(), vec![scope("/workspace/directory")])
        .unwrap();
    let permit = journal.dispatch_legacy(&prepared).unwrap();
    for group in 0..8 {
        let mut children = scope("/workspace/directory/child");
        children.paths = (0..32)
            .map(|n| format!("/workspace/directory/.stage-{}", group * 32 + n))
            .collect();
        assert!(
            journal
                .extend_transfer(permit.claim(), vec![children])
                .unwrap()
                == *permit.claim()
        );
    }
    assert!(matches!(
        native(&mut journal, "directory/child"),
        Err(Error::Occupied)
    ));
    native(&mut journal, "directory-other").unwrap();
    journal.settle_legacy(permit).unwrap();
}
