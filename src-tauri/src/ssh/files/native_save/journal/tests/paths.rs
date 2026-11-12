use super::*;
use crate::ssh::files::native_save::contracts::operation::{Baseline, Prepared};

fn target(
    authority: &crate::ssh::files::native_save::contracts::authority::Authority,
    path: &[&str],
) -> Binding {
    let prepared = Prepared::new(
        authority,
        path.iter().map(|part| part.to_string()).collect(),
        Baseline::Absent,
        "{}".into(),
    )
    .unwrap();
    binding(authority, &prepared)
}

#[test]
fn ancestor_and_descendant_reservations_are_serialized_on_independent_connections() {
    let fixture = Fixture::new();
    let authority = authority();
    let mut first = fixture.create();
    first
        .reserve(target(&authority, &["tree", "note.json"]))
        .unwrap();
    let mut second = Journal::open(&fixture.path()).unwrap();
    for path in [
        vec!["tree"],
        vec!["tree", "note.json"],
        vec!["tree", "note.json", "child"],
    ] {
        assert!(matches!(
            second.reserve(target(&authority, &path)),
            Err(Error::Occupied)
        ));
    }
    second.reserve(target(&authority, &["tree-other"])).unwrap();
    second
        .reserve(target(&authority, &["tree", "sibling.json"]))
        .unwrap();
    drop(first);
    drop(second);
    let mut restarted = Journal::open(&fixture.path()).unwrap();
    assert!(matches!(
        restarted.reserve(target(&authority, &["tree"])),
        Err(Error::Occupied)
    ));
}

#[test]
fn windows_sftp_drive_aliases_and_posix_backslashes_follow_the_remote_namespace() {
    let mut windows = authority();
    windows.context.scope = r"C:\Workspace".into();
    windows.root.platform = "windows".into();
    windows.root.object = "1:2".into();
    windows.root.created = "3:4".into();
    windows.storage_root = windows.root.clone();
    let original = target(&windows, &["Tree", "Note.json"]);
    assert!(original.overlaps_path("/c:/workspace/tree"));
    assert!(original.overlaps_path(r"\\?\c:\WORKSPACE\tree\note.json"));
    assert!(!original.overlaps_path("/c:/workspace/tree-other"));
    assert!(!original.overlaps_path("D:/workspace/tree"));
    assert!(original.overlaps_path("/unknown-namespace"));

    let mut posix = authority();
    posix.context.scope = r"/workspace/literal\".into();
    let original = target(&posix, &["note.json"]);
    assert_eq!(original.target_path(), "/workspace/literal\\/note.json");
    assert!(original.overlaps_path(r"/workspace/literal\"));
    assert!(!original.overlaps_path("/workspace/literal/note.json"));
}

#[test]
fn simultaneous_parent_and_child_admission_has_exactly_one_winner() {
    let fixture = Fixture::new();
    drop(fixture.create());
    let gate = std::sync::Arc::new(std::sync::Barrier::new(2));
    let workers: Vec<_> = [vec!["tree"], vec!["tree", "child"]]
        .into_iter()
        .map(|path| {
            let root = fixture.path();
            let gate = gate.clone();
            std::thread::spawn(move || {
                let mut journal = Journal::open(&root).unwrap();
                gate.wait();
                journal.reserve(target(&authority(), &path))
            })
        })
        .collect();
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
    assert_eq!(
        Journal::open(&fixture.path())
            .unwrap()
            .records()
            .unwrap()
            .len(),
        1
    );
}
