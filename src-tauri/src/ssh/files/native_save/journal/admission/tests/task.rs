use super::super::{TaskEndpoint as Endpoint, TransferTask as Task};
use super::*;

pub(super) fn task(id: &str, path: &str) -> Task {
    Task {
        id: id.into(),
        source: Endpoint {
            path: "/local/input".into(),
            remote: None,
        },
        destination: Endpoint {
            path: path.into(),
            remote: Some(scope(path).destination),
        },
        remove_source: false,
        overwrite: false,
        plugin_id: None,
    }
}

pub(super) fn root(path: &str) -> Scope {
    let mut root = scope(path);
    root.paths.push(path.into());
    root
}

#[test]
fn task_and_original_claim_commit_together_and_survive_reopening() {
    let fixture = Fixture::new();
    let mut journal = fixture.create();
    journal.enable_admission().unwrap();
    let owner = owner();
    let original = task(&owner.id, "/workspace/output");
    let claim = journal
        .reserve_transfer_task(owner, vec![root("/workspace/output")], original.clone())
        .unwrap();
    assert!(claim.transfer_task.as_ref() == Some(&original));
    drop(journal);
    let mut journal = Journal::open(&fixture.path()).unwrap();
    assert!(journal.legacy_claims().unwrap() == [claim.clone()]);
    let permit = journal.dispatch_legacy(&claim).unwrap();
    let next = journal
        .extend_transfer(permit.claim(), vec![scope("/workspace/staging")])
        .unwrap();
    assert!(next.transfer_task.as_ref() == Some(&original));
    assert!(next.transfer_roots == claim.transfer_roots);
    let mut permit = permit;
    let mut changed = next.clone();
    changed.transfer_task.as_mut().unwrap().source.path = "/other/input".into();
    assert!(changed.valid());
    assert!(permit.adopt_transfer_extension(changed).is_err());
    permit.adopt_transfer_extension(next).unwrap();
    let parked = journal.park_transfer(permit).unwrap();
    assert!(parked.transfer_task.as_ref() == Some(&original));
    let resumed = journal.dispatch_legacy(&parked).unwrap();
    assert!(resumed.claim().transfer_task.as_ref() == Some(&original));
    journal.settle_legacy(resumed).unwrap();
}

#[test]
fn duplicate_task_ids_cannot_obtain_disjoint_new_claims() {
    let fixture = Fixture::new();
    let mut journal = fixture.create();
    journal.enable_admission().unwrap();
    let owner = owner();
    let original = task(&owner.id, "/workspace/output");
    journal
        .reserve_transfer_task(owner.clone(), vec![root("/workspace/output")], original)
        .unwrap();
    let mut other = owner;
    other.generation = uuid::Uuid::new_v4().to_string();
    let replaced = task(&other.id, "/workspace/elsewhere");
    assert!(matches!(
        journal.reserve_transfer_task(other, vec![root("/workspace/elsewhere")], replaced),
        Err(Error::Occupied)
    ));
    assert_eq!(journal.legacy_claims().unwrap().len(), 1);
}

#[test]
fn undeclared_initial_paths_cannot_be_attached_to_a_task() {
    let fixture = Fixture::new();
    let mut journal = fixture.create();
    journal.enable_admission().unwrap();
    let owner = owner();
    let task = task(&owner.id, "/workspace/output");
    let mut roots = root("/workspace/output");
    roots
        .paths
        .extend(["/workspace/unrelated".into(), "/workspace/unrelated".into()]);
    assert!(journal
        .reserve_transfer_task(owner, vec![roots], task)
        .is_err());
    assert!(journal.legacy_claims().unwrap().is_empty());
}

#[test]
fn invalid_or_uncovered_operation_intent_never_creates_a_claim() {
    let fixture = Fixture::new();
    let mut journal = fixture.create();
    journal.enable_admission().unwrap();
    let original_owner = owner();
    let original = task(&original_owner.id, "/workspace/output");
    for variant in 0..6 {
        let mut changed = original.clone();
        match variant {
            0 => changed.id = uuid::Uuid::new_v4().to_string(),
            1 => changed.source.path = "relative".into(),
            2 => changed.destination.path = "/workspace/uncovered".into(),
            3 => changed.plugin_id = Some("../other".into()),
            4 => {
                changed.plugin_id = Some("plugin".into());
                changed.remove_source = true;
            }
            5 => changed.destination.remote = None,
            _ => unreachable!(),
        }
        assert!(journal
            .reserve_transfer_task(
                original_owner.clone(),
                vec![root("/workspace/output")],
                changed
            )
            .is_err());
        assert!(journal.legacy_claims().unwrap().is_empty());
    }
}
