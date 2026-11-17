use super::*;
use std::fs;

struct Fixture(std::path::PathBuf);
impl Fixture {
    fn new(config: &str) -> Self {
        let path =
            std::env::temp_dir().join(format!("tunnelde-ssh-import-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(path.join(".ssh")).unwrap();
        let fixture = Self(path);
        fixture.write(config);
        fixture
    }
    fn write(&self, config: &str) {
        fs::write(self.0.join(".ssh/config"), config).unwrap();
    }
    fn discover(&self) -> Discovered {
        parser::discover(&self.0).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn aliases(names: &[&str]) -> Vec<String> {
    names.iter().map(|s| s.to_string()).collect()
}
const CONFIG: &str = "Host bastion\n HostName jump.test\n User jump\nHost app\n HostName app.test\n User deploy\n ProxyJump bastion\n";
fn count(conn: &Connection, table: &str) -> i64 {
    conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
        .unwrap()
}

#[test]
fn production_discovery_imports_jump_dependencies_and_repeats_without_overwrite() {
    let fixture = Fixture::new(CONFIG);
    let db = db::Database::in_memory().unwrap();
    let discovered = fixture.discover();
    let first = import_from(
        &db,
        &fixture.0,
        &aliases(&["app"]),
        &discovered.preview.revision,
        || Ok(()),
    )
    .unwrap();
    assert_eq!(first.imported.len(), 2);
    let jump = first.imported.iter().find(|h| h.name == "bastion").unwrap();
    let app = first.imported.iter().find(|h| h.name == "app").unwrap();
    assert_eq!(app.username, "deploy");
    db.with(|conn| {
        assert_eq!(
            crate::network::route_at(conn, &app.id)?.jump_hosts,
            [jump.id.clone()]
        );
        assert!(
            crate::services::credentials::lifecycle::host_incarnation(conn, &app.id)?.is_some()
        );
        conn.execute(
            "UPDATE hosts SET note='keep user annotation',favorite=1 WHERE id=?1",
            [&app.id],
        )?;
        Ok(())
    })
    .unwrap();
    let second = import_from(
        &db,
        &fixture.0,
        &aliases(&["app", "app"]),
        &discovered.preview.revision,
        || Ok(()),
    )
    .unwrap();
    assert!(second.imported.is_empty());
    assert_eq!(second.skipped, 2);
    db.with(|conn| {
        let saved = db::hosts::find_host(conn, &app.id)?;
        assert_eq!(saved.note.as_deref(), Some("keep user annotation"));
        assert!(saved.favorite);
        assert_eq!(count(conn, "hosts"), 2);
        Ok(())
    })
    .unwrap();
}

#[test]
fn source_revision_change_and_cancelled_admission_never_publish() {
    let fixture = Fixture::new(CONFIG);
    let db = db::Database::in_memory().unwrap();
    let initial = fixture.discover();
    fixture.write(&CONFIG.replace("app.test", "changed.test"));
    assert!(import_from(
        &db,
        &fixture.0,
        &aliases(&["app"]),
        &initial.preview.revision,
        || Ok(())
    )
    .is_err());
    let changed = fixture.discover();
    assert!(import_from(
        &db,
        &fixture.0,
        &aliases(&["app"]),
        &changed.preview.revision,
        || Err(AppError::validation("sshImport.cancelled"))
    )
    .is_err());
    db.with(|conn| {
        assert_eq!(count(conn, "hosts"), 0);
        Ok(())
    })
    .unwrap();
}

#[test]
fn route_failure_rolls_back_hosts_and_credential_rows() {
    let fixture = Fixture::new(CONFIG);
    let db = db::Database::in_memory().unwrap();
    let discovered = fixture.discover();
    db.with(|conn| {
        conn.execute_batch("CREATE TRIGGER reject_import BEFORE INSERT ON settings WHEN NEW.key LIKE 'route:%' BEGIN SELECT RAISE(ABORT,'test route failure'); END;")?;
        Ok(())
    }).unwrap();
    assert!(import_from(
        &db,
        &fixture.0,
        &aliases(&["app"]),
        &discovered.preview.revision,
        || Ok(())
    )
    .is_err());
    db.with(|conn| {
        assert_eq!(count(conn, "hosts"), 0);
        assert_eq!(count(conn, "credential_bindings"), 0);
        Ok(())
    })
    .unwrap();
}

#[test]
fn preview_blocks_unknown_jumps_cycles_conflicts_and_invalid_manual_host_fields() {
    let fixture = Fixture::new("Host a\n ProxyJump b\nHost b\n ProxyJump a\nHost missing\n ProxyJump unknown\nHost safe\n HostName safe.test\n User deploy\nHost conflict\n HostName old.test\n User deploy\n");
    let db = db::Database::in_memory().unwrap();
    db.with(|conn| {
        let input = serde_json::from_value::<crate::models::HostInput>(serde_json::json!({"name":"conflict","host":"new.test","username":"deploy","authMethod":"agent"}))?;
        db::hosts::create_host(conn, &input.validate()?)?;
        Ok(())
    }).unwrap();
    let discovered = fixture.discover();
    let preview = db.with(|conn| preview_at(conn, &discovered)).unwrap();
    for alias in ["a", "b", "missing", "conflict"] {
        assert!(
            !preview
                .entries
                .iter()
                .find(|e| e.alias == alias)
                .unwrap()
                .issues
                .is_empty(),
            "{alias}"
        );
        assert!(import_from(
            &db,
            &fixture.0,
            &aliases(&[alias]),
            &preview.revision,
            || Ok(())
        )
        .is_err());
    }
    let imported = import_from(
        &db,
        &fixture.0,
        &aliases(&["safe"]),
        &preview.revision,
        || Ok(()),
    )
    .unwrap();
    assert_eq!(imported.imported.len(), 1);
}

#[test]
fn nested_single_jump_chain_is_flattened_and_invalid_selection_is_atomic() {
    let fixture = Fixture::new("Host gateway\n HostName gateway.test\n User jump\nHost edge\n HostName edge.test\n User jump\n ProxyJump gateway\nHost app\n HostName app.test\n User deploy\n ProxyJump edge\n");
    let db = db::Database::in_memory().unwrap();
    let discovered = fixture.discover();
    assert!(import_from(
        &db,
        &fixture.0,
        &aliases(&["app", "unknown"]),
        &discovered.preview.revision,
        || Ok(())
    )
    .is_err());
    let imported = import_from(
        &db,
        &fixture.0,
        &aliases(&["app"]),
        &discovered.preview.revision,
        || Ok(()),
    )
    .unwrap();
    assert_eq!(imported.imported.len(), 3);
    db.with(|conn| {
        let ids: BTreeMap<_, _> = imported
            .imported
            .iter()
            .map(|h| (h.name.as_str(), h.id.clone()))
            .collect();
        assert_eq!(
            crate::network::route_at(conn, &ids["app"])?.jump_hosts,
            [ids["gateway"].clone(), ids["edge"].clone()]
        );
        Ok(())
    })
    .unwrap();
}
