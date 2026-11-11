use super::*;

#[test]
fn legacy_pending_defaults_to_apply_and_serializes_without_new_fields() {
    let legacy = serde_json::json!({"id":uuid::Uuid::new_v4().to_string(),"changes":[]});
    let pending: config::Pending = serde_json::from_value(legacy.clone()).unwrap();
    assert_eq!(pending.action, config::Action::Apply);
    assert_eq!(serde_json::to_value(&pending).unwrap(), legacy);
    let mut unknown = legacy;
    unknown["action"] = "discard".into();
    assert!(serde_json::from_value::<config::Pending>(unknown).is_err());
}

fn cancelling(paths: &Paths, state: &mut config::Config) {
    state.pending.as_mut().unwrap().action = config::Action::Cancel;
    config::save(&paths.home, state).unwrap();
}

#[test]
fn failed_cancel_persists_direction_and_restart_never_applies_migration() {
    let (root, paths) = workspace();
    let (moved, mut state, reset, _) = staged_reset(&root, &paths);
    std::fs::write(reset.target.join("draft.json"), b"edited default").unwrap();
    assert!(migration::cancel(&moved, &mut state).is_err());
    assert_eq!(
        state.pending.as_ref().unwrap().action,
        config::Action::Cancel
    );
    assert_eq!(
        config::load(&paths.home).unwrap().pending.unwrap().action,
        config::Action::Cancel
    );
    assert!(migration::apply(&moved, &mut state).is_err());
    let active = initialize(paths.home.clone(), root.join("logs"), None).unwrap();
    assert_eq!(
        active.dir(Category::PluginData),
        moved.dir(Category::PluginData)
    );
    assert_eq!(
        std::fs::read(reset.target.join("draft.json")).unwrap(),
        b"edited default"
    );
    assert!(config::load(&paths.home).unwrap().pending.is_some());
    std::fs::write(reset.target.join("draft.json"), b"current draft").unwrap();
    initialize(paths.home.clone(), root.join("logs"), None).unwrap();
    let complete = config::load(&paths.home).unwrap();
    assert!(complete.pending.is_none());
    assert_eq!(
        std::fs::read(reset.target.join("draft.json")).unwrap(),
        b"old draft"
    );
    assert_eq!(
        std::fs::read(complete.archives[&Category::PluginData].join("draft.json")).unwrap(),
        b"current draft"
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn restart_resumes_each_restore_boundary_and_retains_the_journal() {
    for phase in 0..4 {
        let (root, paths) = workspace();
        let (moved, mut state, reset, stage) = staged_reset(&root, &paths);
        cancelling(&moved, &mut state);
        let id = state.pending.as_ref().unwrap().id.clone();
        let archive = restore::backup_root(reset.category, &reset.target)
            .unwrap()
            .join(id);
        if phase >= 1 {
            std::fs::rename(reset.target.join("draft.json"), stage.join("draft.json")).unwrap();
        }
        if phase >= 2 {
            std::fs::rename(
                archive.join("original/draft.json"),
                reset.target.join("draft.json"),
            )
            .unwrap();
        }
        if phase >= 3 {
            std::fs::rename(&stage, archive.join("cancelled")).unwrap();
            std::fs::write(
                archive.join("cancelled/draft.json"),
                b"edited recovery copy",
            )
            .unwrap();
        }
        let active = initialize(paths.home.clone(), root.join("logs"), None).unwrap();
        let complete = config::load(&paths.home).unwrap();
        assert!(complete.pending.is_none(), "phase {phase}");
        assert_eq!(
            active.dir(Category::PluginData),
            moved.dir(Category::PluginData)
        );
        assert_eq!(
            std::fs::read(reset.target.join("draft.json")).unwrap(),
            b"old draft"
        );
        assert_eq!(
            std::fs::read(complete.archives[&Category::PluginData].join("draft.json")).unwrap(),
            if phase >= 3 {
                b"edited recovery copy".as_slice()
            } else {
                b"current draft".as_slice()
            }
        );
        assert!(archive.join("restore.json").is_file());
        assert!(!stage.exists());
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn cancellation_retains_an_interrupted_archive_preparation_and_staging_together() {
    let (root, paths) = workspace();
    let (moved, mut state, reset, stage) = staged_reset(&root, &paths);
    let id = &state.pending.as_ref().unwrap().id;
    let archive = restore::backup_root(reset.category, &reset.target)
        .unwrap()
        .join(id);
    std::fs::rename(reset.target.join("draft.json"), stage.join("draft.json")).unwrap();
    std::fs::rename(
        archive.join("original/draft.json"),
        reset.target.join("draft.json"),
    )
    .unwrap();
    let preparing = archive.with_extension("preparing");
    std::fs::rename(archive, &preparing).unwrap();
    migration::cancel(&moved, &mut state).unwrap();
    assert!(state.pending.is_none());
    assert_eq!(state.archives[&Category::PluginData], preparing);
    assert_eq!(
        std::fs::read(preparing.join("cancelled/draft.json")).unwrap(),
        b"current draft"
    );
    assert_eq!(
        std::fs::read(reset.target.join("draft.json")).unwrap(),
        b"old draft"
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn ambiguous_stage_and_retained_copy_never_overwrite_each_other() {
    let (root, paths) = workspace();
    let (moved, mut state, reset, stage) = staged_reset(&root, &paths);
    let id = &state.pending.as_ref().unwrap().id;
    let retained = restore::backup_root(reset.category, &reset.target)
        .unwrap()
        .join(id)
        .join("cancelled");
    std::fs::create_dir(&retained).unwrap();
    std::fs::write(retained.join(migration::MARKER), id).unwrap();
    std::fs::write(retained.join("draft.json"), b"other recovery copy").unwrap();
    assert!(migration::cancel(&moved, &mut state).is_err());
    assert!(stage.is_dir());
    assert_eq!(
        std::fs::read(retained.join("draft.json")).unwrap(),
        b"other recovery copy"
    );
    assert_eq!(
        std::fs::read(reset.target.join("draft.json")).unwrap(),
        b"current draft"
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn cancellation_keeps_the_installed_copy_and_conflicting_original_destination() {
    let (root, paths) = workspace();
    let (moved, mut state, reset, stage) = staged_reset(&root, &paths);
    std::fs::rename(reset.target.join("draft.json"), stage.join("draft.json")).unwrap();
    std::fs::write(reset.target.join("draft.json"), b"concurrent creation").unwrap();
    assert!(migration::cancel(&moved, &mut state).is_err());
    assert_eq!(
        std::fs::read(reset.target.join("draft.json")).unwrap(),
        b"concurrent creation"
    );
    assert_eq!(
        std::fs::read(stage.join("draft.json")).unwrap(),
        b"current draft"
    );
    let id = &state.pending.as_ref().unwrap().id;
    let saved = restore::backup_root(reset.category, &reset.target)
        .unwrap()
        .join(id)
        .join("original/draft.json");
    assert_eq!(std::fs::read(saved).unwrap(), b"old draft");
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_missing_original_never_counts_as_a_completed_restoration() {
    let (root, paths) = workspace();
    let (moved, mut state, reset, stage) = staged_reset(&root, &paths);
    let id = &state.pending.as_ref().unwrap().id;
    let saved = restore::backup_root(reset.category, &reset.target)
        .unwrap()
        .join(id)
        .join("original/draft.json");
    std::fs::remove_file(saved).unwrap();
    assert!(migration::cancel(&moved, &mut state).is_err());
    assert_eq!(
        state.pending.as_ref().unwrap().action,
        config::Action::Cancel
    );
    assert_eq!(
        std::fs::read(stage.join("draft.json")).unwrap(),
        b"current draft"
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn batch_cancellation_records_prior_copies_before_a_later_category_conflicts() {
    let (root, paths) = workspace();
    let (moved, mut state, reset, _) = staged_reset(&root, &paths);
    let keys = change(&root, Category::Keys);
    std::fs::create_dir_all(&keys.target).unwrap();
    std::fs::write(
        keys.target.join(migration::MARKER),
        &state.pending.as_ref().unwrap().id,
    )
    .unwrap();
    std::fs::write(keys.target.join("retained"), b"edited staged data").unwrap();
    state
        .pending
        .as_mut()
        .unwrap()
        .changes
        .insert(0, keys.clone());
    config::save(&paths.home, &state).unwrap();
    std::fs::write(reset.target.join("draft.json"), b"conflict").unwrap();
    assert!(migration::cancel(&moved, &mut state).is_err());
    let persisted = config::load(&paths.home).unwrap();
    assert_eq!(persisted.archives[&Category::Keys], keys.target);
    assert_eq!(
        persisted.pending.as_ref().unwrap().action,
        config::Action::Cancel
    );
    std::fs::write(reset.target.join("draft.json"), b"current draft").unwrap();
    initialize(paths.home.clone(), root.join("logs"), None).unwrap();
    assert!(config::load(&paths.home).unwrap().pending.is_none());
    assert_eq!(
        std::fs::read(keys.target.join("retained")).unwrap(),
        b"edited staged data"
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn verified_staging_resumes_but_partial_or_changed_staging_is_preserved() {
    for complete in [false, true] {
        let (root, paths) = workspace();
        let mut state = config::Config::default();
        std::fs::create_dir_all(paths.dir(Category::Keys)).unwrap();
        std::fs::write(paths.dir(Category::Keys).join("key"), b"original").unwrap();
        migration::schedule(&paths, &mut state, vec![change(&root, Category::Keys)]).unwrap();
        let pending = state.pending.as_ref().unwrap();
        let stage = migration::stage(&pending.changes[0], &pending.id).unwrap();
        std::fs::create_dir_all(&stage).unwrap();
        std::fs::write(stage.join(migration::MARKER), &pending.id).unwrap();
        std::fs::write(
            stage.join("key"),
            if complete {
                b"original".as_slice()
            } else {
                b"partial".as_slice()
            },
        )
        .unwrap();
        if complete {
            migration::apply(&paths, &mut state).unwrap();
            assert!(state.pending.is_none());
        } else {
            assert!(migration::apply(&paths, &mut state).is_err());
            assert_eq!(std::fs::read(stage.join("key")).unwrap(), b"partial");
            migration::cancel(&paths, &mut state).unwrap();
            assert_eq!(state.archives[&Category::Keys], stage);
            assert_eq!(std::fs::read(stage.join("key")).unwrap(), b"partial");
        }
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn failed_cancellation_intent_save_never_touches_entries_or_in_memory_plan() {
    let (root, paths) = workspace();
    let (moved, mut state, reset, _) = staged_reset(&root, &paths);
    let original = config::load(&paths.home).unwrap();
    std::fs::remove_file(paths.home.join("storage.json")).unwrap();
    std::fs::create_dir(paths.home.join("storage.json")).unwrap();
    assert!(migration::cancel(&moved, &mut state).is_err());
    assert_eq!(
        state.pending.as_ref().unwrap().action,
        config::Action::Apply
    );
    assert_eq!(state.locations, original.locations);
    assert_eq!(
        std::fs::read(reset.target.join("draft.json")).unwrap(),
        b"current draft"
    );
    std::fs::remove_dir_all(root).unwrap();
}
