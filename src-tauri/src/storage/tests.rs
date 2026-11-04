use super::*;
use std::collections::BTreeMap;
use std::path::PathBuf;

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
