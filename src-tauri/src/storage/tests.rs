use super::*;
use std::collections::BTreeMap;
use std::path::PathBuf;

mod recovery;

fn workspace() -> (PathBuf, Paths) {
    let root = std::env::temp_dir().join(format!("tunnelde-storage-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(root.join("home")).unwrap();
    let paths = Paths::new(root.join("home"), root.join("logs"), &BTreeMap::new(), None);
    (root, paths)
}

fn change(root: &std::path::Path, category: Category) -> config::Change {
    config::Change {
        category,
        target: root.join("new").join(category.name()),
        migrate: true,
    }
}

#[test]
fn batch_copy_verifies_bytes_switches_together_and_keeps_originals() {
    let (root, paths) = workspace();
    std::fs::create_dir_all(paths.dir(Category::PluginData)).unwrap();
    std::fs::create_dir_all(paths.dir(Category::Keys)).unwrap();
    std::fs::write(
        paths.dir(Category::PluginData).join("chat.json"),
        b"chat and drafts",
    )
    .unwrap();
    std::fs::write(
        paths.dir(Category::Keys).join("key.pem"),
        b"disposable test bytes",
    )
    .unwrap();
    std::fs::write(paths.dir(Category::Database).join("tunnelde.db"), b"db").unwrap();
    std::fs::write(paths.home.join("unrelated.txt"), b"keep").unwrap();
    let mut config = config::Config::default();
    migration::schedule(
        &paths,
        &mut config,
        vec![
            change(&root, Category::PluginData),
            change(&root, Category::Keys),
            change(&root, Category::Database),
        ],
    )
    .unwrap();
    assert!(config.locations.is_empty());
    migration::apply(&paths, &mut config).unwrap();
    assert!(config.pending.is_none());
    assert_eq!(config.locations.len(), 3);
    assert_eq!(
        std::fs::read(root.join("new/plugin-data/chat.json")).unwrap(),
        b"chat and drafts"
    );
    assert_eq!(
        std::fs::read(paths.dir(Category::PluginData).join("chat.json")).unwrap(),
        b"chat and drafts"
    );
    assert_eq!(
        std::fs::read(root.join("new/database/tunnelde.db")).unwrap(),
        b"db"
    );
    assert!(!root.join("new/database/unrelated.txt").exists());
    assert_eq!(
        std::fs::read(paths.home.join("unrelated.txt")).unwrap(),
        b"keep"
    );
    assert_eq!(
        config::load(&paths.home).unwrap().locations,
        config.locations
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn conflicts_nesting_and_duplicate_categories_never_change_configuration() {
    let (root, paths) = workspace();
    let first = change(&root, Category::Keys);
    std::fs::create_dir_all(&first.target).unwrap();
    std::fs::write(first.target.join("existing"), b"keep").unwrap();
    assert!(migration::validate(&paths, std::slice::from_ref(&first)).is_err());
    std::fs::remove_file(first.target.join("existing")).unwrap();
    assert!(migration::validate(&paths, &[first.clone(), first]).is_err());
    let mut nested = change(&root, Category::Keys);
    nested.target = paths.dir(Category::Keys).join("nested");
    assert!(migration::validate(&paths, &[nested]).is_err());
    let a = change(&root, Category::Keys);
    let mut b = change(&root, Category::PluginData);
    b.target = a.target.join("nested");
    assert!(migration::validate(&paths, &[a, b]).is_err());
    assert!(config::load(&paths.home).unwrap().locations.is_empty());
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn changed_destination_at_restart_keeps_sources_and_reverts_to_current_paths() {
    let (root, paths) = workspace();
    std::fs::create_dir_all(paths.dir(Category::Keys)).unwrap();
    std::fs::write(paths.dir(Category::Keys).join("old"), b"original").unwrap();
    let destination = change(&root, Category::Keys);
    let mut config = config::Config::default();
    migration::schedule(&paths, &mut config, vec![destination.clone()]).unwrap();
    std::fs::create_dir_all(&destination.target).unwrap();
    std::fs::write(destination.target.join("user-created"), b"keep").unwrap();
    let actual = initialize(paths.home.clone(), root.join("logs"), None).unwrap();
    assert_eq!(actual.dir(Category::Keys), paths.dir(Category::Keys));
    assert!(config::load(&paths.home).unwrap().last_error.is_some());
    assert_eq!(
        std::fs::read(destination.target.join("user-created")).unwrap(),
        b"keep"
    );
    assert_eq!(
        std::fs::read(paths.dir(Category::Keys).join("old")).unwrap(),
        b"original"
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn no_copy_selects_empty_storage_and_invalid_bootstrap_config_is_not_silently_reset() {
    let (root, paths) = workspace();
    std::fs::create_dir_all(paths.dir(Category::PluginData)).unwrap();
    std::fs::write(paths.dir(Category::PluginData).join("old"), b"original").unwrap();
    let mut destination = change(&root, Category::PluginData);
    destination.migrate = false;
    let mut config = config::Config::default();
    migration::schedule(&paths, &mut config, vec![destination]).unwrap();
    migration::apply(&paths, &mut config).unwrap();
    assert!(!root.join("new/plugin-data/old").exists());
    assert!(paths.dir(Category::PluginData).join("old").exists());
    std::fs::write(paths.home.join("storage.json"), b"broken").unwrap();
    assert!(config::load(&paths.home).is_err());
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn interrupted_published_copy_is_reverified_and_resumed() {
    let (root, paths) = workspace();
    std::fs::create_dir_all(paths.dir(Category::PluginData)).unwrap();
    std::fs::write(paths.dir(Category::PluginData).join("chat.json"), b"chat").unwrap();
    let destination = change(&root, Category::PluginData);
    let mut config = config::Config::default();
    migration::schedule(&paths, &mut config, vec![destination.clone()]).unwrap();
    let id = config.pending.as_ref().unwrap().id.clone();
    std::fs::create_dir_all(&destination.target).unwrap();
    std::fs::write(destination.target.join("chat.json"), b"chat").unwrap();
    std::fs::write(destination.target.join(".tunnelde-storage-migration"), id).unwrap();
    migration::apply(&paths, &mut config).unwrap();
    assert!(config.pending.is_none());
    assert!(!destination
        .target
        .join(".tunnelde-storage-migration")
        .exists());
    assert_eq!(
        std::fs::read(destination.target.join("chat.json")).unwrap(),
        b"chat"
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn changed_interrupted_copy_is_never_replaced_or_selected() {
    let (root, paths) = workspace();
    std::fs::create_dir_all(paths.dir(Category::PluginData)).unwrap();
    std::fs::write(paths.dir(Category::PluginData).join("chat.json"), b"chat").unwrap();
    let destination = change(&root, Category::PluginData);
    let mut config = config::Config::default();
    migration::schedule(&paths, &mut config, vec![destination.clone()]).unwrap();
    let id = config.pending.as_ref().unwrap().id.clone();
    std::fs::create_dir_all(&destination.target).unwrap();
    std::fs::write(destination.target.join("chat.json"), b"changed by user").unwrap();
    std::fs::write(destination.target.join(".tunnelde-storage-migration"), id).unwrap();
    assert!(migration::apply(&paths, &mut config).is_err());
    assert!(config.locations.is_empty());
    assert!(config.pending.is_some());
    assert_eq!(
        std::fs::read(destination.target.join("chat.json")).unwrap(),
        b"changed by user"
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn pending_plan_cannot_be_overwritten_and_environment_managed_plugins_are_locked() {
    let (root, paths) = workspace();
    let mut config = config::Config::default();
    migration::schedule(&paths, &mut config, vec![change(&root, Category::Keys)]).unwrap();
    let id = config.pending.as_ref().unwrap().id.clone();
    assert!(
        migration::schedule(&paths, &mut config, vec![change(&root, Category::Cache)]).is_err()
    );
    assert_eq!(config.pending.as_ref().unwrap().id, id);
    let overridden = Paths::new(
        paths.home.clone(),
        root.join("logs"),
        &BTreeMap::new(),
        Some(root.join("external-plugins")),
    );
    assert!(migration::validate(&overridden, &[change(&root, Category::Plugins)]).is_err());
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn database_and_key_references_survive_migration_without_rewriting_external_keys() {
    let (root, paths) = workspace();
    let original_db = paths.dir(Category::Database).join("tunnelde.db");
    let db = crate::db::Database::open(&original_db).unwrap();
    std::fs::create_dir_all(paths.dir(Category::Keys)).unwrap();
    let key = paths.dir(Category::Keys).join("managed.pem");
    std::fs::write(&key, b"test only").unwrap();
    db.with(|conn| {
        conn.execute("INSERT INTO hosts (id,name,host,port,username,auth_method,key_path,favorite,color,tags,note,created_at,updated_at) VALUES ('managed','Managed','localhost',22,'test','key',?1,0,'', '[]','',0,0)", [key.to_string_lossy().as_ref()])?;
        conn.execute("INSERT INTO hosts (id,name,host,port,username,auth_method,key_path,favorite,color,tags,note,created_at,updated_at) VALUES ('external','External','localhost',22,'test','key',?1,0,'', '[]','',0,0)", [root.join("external.pem").to_string_lossy().as_ref()])?;
        Ok(())
    }).unwrap();
    drop(db);
    let mut config = config::Config::default();
    migration::schedule(
        &paths,
        &mut config,
        vec![
            change(&root, Category::Database),
            change(&root, Category::Keys),
        ],
    )
    .unwrap();
    let next = initialize(paths.home.clone(), root.join("logs"), None).unwrap();
    let db = crate::db::Database::open(&next.dir(Category::Database).join("tunnelde.db")).unwrap();
    relocate_key_references(&db, &next).unwrap();
    db.with(|conn| {
        let managed: String =
            conn.query_row("SELECT key_path FROM hosts WHERE id='managed'", [], |row| {
                row.get(0)
            })?;
        assert_eq!(
            layout::normalize(std::path::Path::new(&managed)).unwrap(),
            layout::normalize(&next.dir(Category::Keys).join("managed.pem")).unwrap()
        );
        let external: String = conn.query_row(
            "SELECT key_path FROM hosts WHERE id='external'",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(external, root.join("external.pem").to_string_lossy());
        Ok(())
    })
    .unwrap();
    drop(db);
    assert!(original_db.is_file());
    let db = crate::db::Database::open(&next.dir(Category::Database).join("tunnelde.db")).unwrap();
    db.with(|conn| {
        conn.execute(
            "UPDATE hosts SET name='After migration' WHERE id='managed'",
            [],
        )?;
        Ok(())
    })
    .unwrap();
    drop(db);
    let mut config = config::load(&paths.home).unwrap();
    migration::schedule(
        &next,
        &mut config,
        vec![
            config::Change {
                category: Category::Database,
                target: paths.dir(Category::Database).to_owned(),
                migrate: true,
            },
            config::Change {
                category: Category::Keys,
                target: paths.dir(Category::Keys).to_owned(),
                migrate: true,
            },
        ],
    )
    .unwrap();
    let restored = initialize(paths.home.clone(), root.join("logs"), None).unwrap();
    let db =
        crate::db::Database::open(&restored.dir(Category::Database).join("tunnelde.db")).unwrap();
    relocate_key_references(&db, &restored).unwrap();
    db.with(|conn| {
        let (name, key_path): (String, String) = conn.query_row(
            "SELECT name,key_path FROM hosts WHERE id='managed'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        assert_eq!(name, "After migration");
        assert_eq!(
            layout::normalize(std::path::Path::new(&key_path)).unwrap(),
            layout::normalize(&key).unwrap()
        );
        Ok(())
    })
    .unwrap();
    drop(db);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn reset_all_categories_preserves_shared_root_and_archives_old_defaults() {
    let (root, paths) = workspace();
    for category in CATEGORIES {
        for entry in inventory::roots(category, paths.dir(category)) {
            if category == Category::Database {
                std::fs::write(entry, b"old database").unwrap();
            } else {
                std::fs::create_dir_all(&entry).unwrap();
                std::fs::write(entry.join("fixture"), b"old default").unwrap();
            }
        }
    }
    std::fs::write(paths.home.join("unrelated.txt"), b"do not move").unwrap();
    let mut config = config::Config::default();
    migration::schedule(
        &paths,
        &mut config,
        CATEGORIES.into_iter().map(|c| change(&root, c)).collect(),
    )
    .unwrap();
    migration::apply(&paths, &mut config).unwrap();
    let moved = Paths::new(
        paths.home.clone(),
        root.join("logs"),
        &config.locations,
        None,
    );
    for category in CATEGORIES {
        for entry in inventory::roots(category, moved.dir(category)) {
            if category == Category::Database {
                std::fs::write(entry, b"current database").unwrap();
            } else {
                std::fs::write(entry.join("fixture"), b"current data").unwrap();
            }
        }
    }
    migration::schedule(
        &moved,
        &mut config,
        CATEGORIES
            .into_iter()
            .map(|category| config::Change {
                category,
                target: paths.defaults[&category].clone(),
                migrate: true,
            })
            .collect(),
    )
    .unwrap();
    migration::apply(&moved, &mut config).unwrap();
    assert!(config.locations.is_empty());
    assert!(config.pending.is_none());
    assert_eq!(config.archives.len(), 8);
    assert_eq!(
        std::fs::read(paths.home.join("unrelated.txt")).unwrap(),
        b"do not move"
    );
    assert!(paths.home.join("storage.json").is_file());
    for category in CATEGORIES {
        assert_eq!(config.previous[&category], moved.dir(category));
        for entry in inventory::roots(category, paths.dir(category)) {
            let name = entry.file_name().unwrap();
            let archived = config.archives[&category].join(name);
            let (current, saved) = if category == Category::Database {
                (
                    std::fs::read(&entry).unwrap(),
                    std::fs::read(archived).unwrap(),
                )
            } else if category == Category::Cache {
                (
                    std::fs::read(entry.join("fixture")).unwrap(),
                    std::fs::read(archived.join("fixture")).unwrap(),
                )
            } else {
                (
                    std::fs::read(entry.join("fixture")).unwrap(),
                    std::fs::read(config.archives[&category].join("fixture")).unwrap(),
                )
            };
            assert_eq!(
                current,
                if category == Category::Database {
                    b"current database".as_slice()
                } else {
                    b"current data".as_slice()
                }
            );
            assert_eq!(
                saved,
                if category == Category::Database {
                    b"old database".as_slice()
                } else {
                    b"old default".as_slice()
                }
            );
        }
        assert!(moved.dir(category).is_dir());
    }
    let actual = initialize(paths.home.clone(), root.join("logs"), None).unwrap();
    for category in CATEGORIES {
        assert_eq!(
            layout::normalize(actual.dir(category)).unwrap(),
            layout::normalize(paths.dir(category)).unwrap()
        );
    }
    std::fs::remove_dir_all(root).unwrap();
}

fn staged_reset(
    root: &std::path::Path,
    paths: &Paths,
) -> (Paths, config::Config, config::Change, PathBuf) {
    let category = Category::PluginData;
    std::fs::create_dir_all(paths.dir(category)).unwrap();
    std::fs::write(paths.dir(category).join("draft.json"), b"old draft").unwrap();
    let mut config = config::Config::default();
    migration::schedule(paths, &mut config, vec![change(root, category)]).unwrap();
    migration::apply(paths, &mut config).unwrap();
    let moved = Paths::new(
        paths.home.clone(),
        root.join("logs"),
        &config.locations,
        None,
    );
    std::fs::write(moved.dir(category).join("draft.json"), b"current draft").unwrap();
    let mut reset = config::Change {
        category,
        target: paths.dir(category).to_owned(),
        migrate: true,
    };
    migration::schedule(&moved, &mut config, vec![reset.clone()]).unwrap();
    reset = config.pending.as_ref().unwrap().changes[0].clone();
    let id = &config.pending.as_ref().unwrap().id;
    let stage = migration::stage(&reset, id).unwrap();
    std::fs::create_dir(&stage).unwrap();
    std::fs::write(stage.join(migration::MARKER), id).unwrap();
    inventory::copy_verified(
        &moved.dir(category).join("draft.json"),
        &stage.join("draft.json"),
        0,
    )
    .unwrap();
    restore::publish(&moved, &reset, id, &stage).unwrap();
    (moved, config, reset, stage)
}

#[test]
fn reset_recovers_after_publication_before_configuration_commit() {
    let (root, paths) = workspace();
    let (moved, mut config, reset, stage) = staged_reset(&root, &paths);
    assert!(config.pending.is_some());
    assert_eq!(
        std::fs::read(reset.target.join("draft.json")).unwrap(),
        b"current draft"
    );
    migration::apply(&moved, &mut config).unwrap();
    assert!(config.pending.is_none());
    assert!(!config.locations.contains_key(&Category::PluginData));
    assert!(!stage.exists());
    assert_eq!(
        std::fs::read(config.archives[&Category::PluginData].join("draft.json")).unwrap(),
        b"old draft"
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn reset_resumes_after_archiving_defaults_before_publishing_entries() {
    let (root, paths) = workspace();
    let (moved, mut config, reset, stage) = staged_reset(&root, &paths);
    std::fs::rename(reset.target.join("draft.json"), stage.join("draft.json")).unwrap();
    migration::apply(&moved, &mut config).unwrap();
    assert!(config.pending.is_none());
    assert_eq!(
        std::fs::read(reset.target.join("draft.json")).unwrap(),
        b"current draft"
    );
    assert_eq!(
        std::fs::read(config.archives[&Category::PluginData].join("draft.json")).unwrap(),
        b"old draft"
    );
    assert!(!stage.exists());
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn reset_starting_empty_archives_existing_default_data() {
    let (root, paths) = workspace();
    let (moved, mut config, reset, _) = staged_reset(&root, &paths);
    migration::cancel(&moved, &mut config).unwrap();
    let mut empty = reset;
    empty.migrate = false;
    migration::schedule(&moved, &mut config, vec![empty]).unwrap();
    migration::apply(&moved, &mut config).unwrap();
    assert!(!paths.dir(Category::PluginData).join("draft.json").exists());
    assert_eq!(
        std::fs::read(config.archives[&Category::PluginData].join("draft.json")).unwrap(),
        b"old draft"
    );
    assert_eq!(
        std::fs::read(moved.dir(Category::PluginData).join("draft.json")).unwrap(),
        b"current draft"
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn cancel_reset_restores_defaults_and_never_deletes_changed_published_data() {
    let (root, paths) = workspace();
    let (moved, mut config, reset, stage) = staged_reset(&root, &paths);
    std::fs::write(reset.target.join("draft.json"), b"user changed this").unwrap();
    assert!(migration::apply(&moved, &mut config).is_err());
    assert!(stage.is_dir());
    assert!(migration::cancel(&moved, &mut config).is_err());
    assert!(config.pending.is_some());
    assert_eq!(
        std::fs::read(reset.target.join("draft.json")).unwrap(),
        b"user changed this"
    );
    std::fs::write(reset.target.join("draft.json"), b"current draft").unwrap();
    migration::cancel(&moved, &mut config).unwrap();
    assert!(config.pending.is_none());
    assert!(!stage.exists());
    assert_eq!(
        std::fs::read(reset.target.join("draft.json")).unwrap(),
        b"old draft"
    );
    assert_eq!(
        std::fs::read(moved.dir(Category::PluginData).join("draft.json")).unwrap(),
        b"current draft"
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[cfg(unix)]
#[test]
fn symlink_data_is_rejected_without_reading_outside_the_category() {
    let (root, paths) = workspace();
    std::fs::create_dir_all(paths.dir(Category::Keys)).unwrap();
    std::fs::write(root.join("outside"), b"outside").unwrap();
    std::os::unix::fs::symlink(root.join("outside"), paths.dir(Category::Keys).join("link"))
        .unwrap();
    assert!(inventory::scan(Category::Keys, paths.dir(Category::Keys)).is_err());
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn native_save_recovery_directory_moves_with_database_and_cannot_be_left_behind() {
    let (root, paths) = workspace();
    let directory = paths.dir(Category::Database).join("native-file-saves");
    std::fs::create_dir(&directory).unwrap();
    let files = [
        "recovery.sqlite3",
        "recovery.sqlite3-wal",
        "recovery.sqlite3-shm",
        "recovery.sqlite3-journal",
    ];
    for name in files {
        std::fs::write(directory.join(name), name.as_bytes()).unwrap();
    }
    let mut change = change(&root, Category::Database);
    change.migrate = false;
    assert!(migration::validate(&paths, &[change.clone()])
        .unwrap_err()
        .to_string()
        .contains("storage.nativeRecoveryRequiresMigration"));
    change.migrate = true;
    let mut config = config::Config::default();
    migration::schedule(&paths, &mut config, vec![change.clone()]).unwrap();
    migration::apply(&paths, &mut config).unwrap();
    for name in files {
        assert_eq!(
            std::fs::read(change.target.join("native-file-saves").join(name)).unwrap(),
            name.as_bytes()
        );
        assert_eq!(
            std::fs::read(directory.join(name)).unwrap(),
            name.as_bytes()
        );
    }
    let moved = Paths::new(
        paths.home.clone(),
        root.join("logs"),
        &config.locations,
        None,
    );
    migration::schedule(
        &moved,
        &mut config,
        vec![config::Change {
            category: Category::Database,
            target: paths.dir(Category::Database).to_owned(),
            migrate: true,
        }],
    )
    .unwrap();
    migration::apply(&moved, &mut config).unwrap();
    for name in files {
        assert_eq!(
            std::fs::read(directory.join(name)).unwrap(),
            name.as_bytes()
        );
        assert_eq!(
            std::fs::read(
                config.archives[&Category::Database]
                    .join("native-file-saves")
                    .join(name)
            )
            .unwrap(),
            name.as_bytes()
        );
    }
    std::fs::remove_dir_all(root).unwrap();
}
