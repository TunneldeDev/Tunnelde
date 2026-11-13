use super::super::TransferOutcome;
use super::*;

#[test]
fn original_terminal_stays_blocking_until_exact_projection_acknowledgement() {
    let fixture = Fixture::new();
    let mut journal = fixture.create();
    journal.enable_admission().unwrap();
    let owner = owner();
    let claim = journal
        .reserve_transfer_task(
            owner.clone(),
            vec![task::root("/workspace/output")],
            task::task(&owner.id, "/workspace/output"),
        )
        .unwrap();
    let permit = journal.dispatch_legacy(&claim).unwrap();
    let terminal = journal
        .complete_transfer(
            permit,
            TransferOutcome::Completed {
                transferred: 42,
                total: 42,
            },
        )
        .unwrap();
    assert!(terminal.phase == Phase::Terminal && terminal.valid());
    assert!(journal.dispatch_legacy(&terminal).is_err());
    assert!(journal.retire_unsent_legacy(&terminal).is_err());
    assert!(matches!(
        native(&mut journal, "output/child"),
        Err(Error::Occupied)
    ));
    drop(journal);
    let mut journal = Journal::open(&fixture.path()).unwrap();
    assert!(journal.legacy_claims().unwrap() == [terminal.clone()]);
    let mut stale = terminal.clone();
    stale.terminal = Some(TransferOutcome::Disposed);
    assert!(journal.retire_transfer_terminal(&stale).is_err());
    assert!(journal.legacy_claims().unwrap() == [terminal.clone()]);
    journal.retire_transfer_terminal(&terminal).unwrap();
    assert!(journal.legacy_claims().unwrap().is_empty());
    native(&mut journal, "output/child").unwrap();
}

#[test]
fn only_known_unsent_tasks_can_dispose_without_artifact_completion_evidence() {
    for parked in [false, true] {
        let fixture = Fixture::new();
        let mut journal = fixture.create();
        journal.enable_admission().unwrap();
        let owner = owner();
        let mut claim = journal
            .reserve_transfer_task(
                owner.clone(),
                vec![task::root("/workspace/output")],
                task::task(&owner.id, "/workspace/output"),
            )
            .unwrap();
        if parked {
            let permit = journal.dispatch_legacy(&claim).unwrap();
            assert!(journal.dispose_empty_transfer(permit.claim()).is_err());
            claim = journal.park_transfer(permit).unwrap();
            assert!(journal.dispose_empty_transfer(&claim).is_err());
            assert!(journal.legacy_claims().unwrap() == [claim]);
            continue;
        }
        let terminal = journal.dispose_empty_transfer(&claim).unwrap();
        assert!(
            terminal.phase == Phase::Terminal
                && terminal.terminal == Some(TransferOutcome::Disposed)
        );
        assert!(journal.dispatch_legacy(&claim).is_err());
        assert!(journal.dispose_empty_transfer(&claim).is_err());
        journal.retire_transfer_terminal(&terminal).unwrap();
    }
}

#[test]
fn malformed_outcomes_cannot_turn_dispatched_tasks_into_terminal_evidence() {
    let fixture = Fixture::new();
    let mut journal = fixture.create();
    journal.enable_admission().unwrap();
    let owner = owner();
    let claim = journal
        .reserve_transfer_task(
            owner.clone(),
            vec![task::root("/workspace/output")],
            task::task(&owner.id, "/workspace/output"),
        )
        .unwrap();
    let permit = journal.dispatch_legacy(&claim).unwrap();
    let dispatched = permit.claim().clone();
    assert!(journal
        .complete_transfer(
            permit,
            TransferOutcome::Completed {
                transferred: 1,
                total: 2
            }
        )
        .is_err());
    assert!(journal.legacy_claims().unwrap() == [dispatched]);
    let mut forged = claim.clone();
    forged.terminal = Some(TransferOutcome::Disposed);
    assert!(!forged.valid());
    let unbound = journal
        .reserve_legacy(Kind::Transfer, super::owner(), vec![scope("/different")])
        .unwrap();
    let permit = journal.dispatch_legacy(&unbound).unwrap();
    assert!(journal
        .complete_transfer(permit, TransferOutcome::Disposed)
        .is_err());
}
