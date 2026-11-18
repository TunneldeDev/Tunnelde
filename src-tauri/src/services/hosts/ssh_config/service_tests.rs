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
            crate::network::route_at(conn, &app.id)?
                .jump_hosts
                .as_slice(),
            std::slice::from_ref(&jump.id)
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
fn paged_preview_uses_source_revision_and_visits_every_alias_once() {
    let config = (0..35)
        .map(|index| format!("Host server-{index}\n User deploy\n"))
        .collect::<String>();
    let fixture = Fixture::new(&config);
    let source = fixture.discover();
    let db = db::Database::in_memory().unwrap();
    let first = db.with(|conn| page_at(conn, &source, 0, None)).unwrap();
    let revision = first.revision.clone();
    let resume_at = first.next_offset.unwrap();
    assert_eq!(first.total, 35);
    assert_eq!(resume_at, 16);
    let mut next = first.next_offset;
    let mut seen: Vec<_> = first.entries.into_iter().map(|entry| entry.alias).collect();
    while let Some(offset) = next {
        let page = db
            .with(|conn| page_at(conn, &source, offset, Some(&revision)))
            .unwrap();
        next = page.next_offset;
        seen.extend(page.entries.into_iter().map(|entry| entry.alias));
    }
    assert_eq!(
        seen,
        (0..35)
            .map(|index| format!("server-{index}"))
            .collect::<Vec<_>>()
    );
    fixture.write(&format!("{config}\n# revision changed"));
    assert!(db
        .with(|conn| page_at(conn, &fixture.discover(), resume_at, Some(&revision)))
        .is_err());
}

#[test]
fn preview_pages_bound_diagnostics_and_move_the_offset_only_past_returned_entries() {
    let fixture = Fixture::new(CONFIG);
    let mut source = fixture.discover();
    let mut entry = source.preview.entries[0].clone();
    entry.alias = "\u{1}".repeat(4096);
    let input = entry.input.as_mut().unwrap();
    input.name.clone_from(&entry.alias);
    input.key_path = Some("x".repeat(1025));
    entry.issues = vec![Issue::new(IssueCode::InvalidValue, "界".repeat(200)); 20];
    entry.jump_aliases = vec!["\u{1}".repeat(4096); 10];
    source.preview.issues = entry.issues.clone();
    source.preview.entries = vec![entry; 35];
    let page = PreviewPage::from_preview(source.preview, 0).unwrap();
    assert!(!page.entries.is_empty());
    assert_eq!(page.next_offset, Some(page.entries.len()));
    assert_eq!(page.issues.len(), 16);
    assert!(page.issues.iter().all(|issue| issue.detail.len() <= 256));
    for entry in &page.entries {
        assert!(entry.input.is_none());
        assert_eq!(entry.issues.len(), 8);
        assert_eq!(entry.jump_aliases.len(), 8);
    }
    assert!(serde_json::to_vec(&page).unwrap().len() < 540 * 1024);
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
