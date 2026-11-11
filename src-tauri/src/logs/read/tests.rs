use super::*;
use crate::{db::Database, error::AppError};
use contracts::{Page, Request};
use serde_json::{json, Value};
use std::{io::Write, path::PathBuf};
struct Fixture {
    dir: PathBuf,
    db: Database,
}
impl Fixture {
    fn new() -> Self {
        let dir =
            std::env::temp_dir().join(format!("tunnelde-public-logs-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        Self {
            dir,
            db: Database::in_memory().unwrap(),
        }
    }
    fn path(&self) -> PathBuf {
        self.dir.join("2026-11-11.tunnelde.jsonl.log")
    }
    fn read(&self, params: Value) -> Page {
        self.owner("test:fingerprint:1", params).unwrap()
    }
    fn owner(&self, owner: &str, params: Value) -> crate::error::AppResult<Page> {
        read(
            &self.dir,
            &self.db,
            owner,
            serde_json::from_value(params).unwrap(),
            || Ok(()),
        )
    }
    fn write(&self, value: &str) {
        std::fs::write(self.path(), value).unwrap();
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}
fn line(message: &str) -> String {
    format!(
        "{}\n",
        json!({"timestamp":"2026-11-11T10:00:00Z","level":"INFO","fields":{"message":message,"domain":"network"}})
    )
}

#[test]
fn strict_request_and_cursor_scope() {
    for params in [
        json!(null),
        json!({"source":null}),
        json!({"cursor":null}),
        json!({"limit":0}),
        json!({"limit":201}),
        json!({"filter":{"levels":["INFO"]}}),
        json!({"filter":{"plugins":["a","a"]}}),
        json!({"path":"C:/"}),
    ] {
        assert!(serde_json::from_value::<Request>(params).is_err());
    }
    let fixture = Fixture::new();
    fixture.write(&line("first"));
    let page = fixture.read(json!({}));
    for (owner, params) in [
        ("other", json!({"cursor":page.cursor})),
        (
            "test:fingerprint:1",
            json!({"cursor":page.cursor,"source":"operations"}),
        ),
        (
            "test:fingerprint:1",
            json!({"cursor":page.cursor,"filter":{"text":"first"}}),
        ),
    ] {
        assert_eq!(
            fixture.owner(owner, params).err().unwrap().to_string(),
            "logs.read.invalidCursor"
        );
    }
    assert!(cursor::decode(Some(&"a".repeat(2049)), "ignored").is_err());
}

#[test]
fn public_directory_scan_fails_explicitly_at_budget_without_changing_native_selection() {
    let fixture = Fixture::new();
    fixture.write(&line("current"));
    // Use a small injected budget to exercise the same selection path cheaply.
    std::fs::write(fixture.dir.join("unrelated"), "ignored").unwrap();
    assert_eq!(
        crate::logs::select_name(&fixture.dir, Some(1))
            .unwrap_err()
            .to_string(),
        "logs.read.unavailable"
    );
    assert!(crate::logs::latest_name(&fixture.dir).unwrap().is_some());
}
#[test]
fn pagination_filters_and_partial_tail_have_no_loss_or_duplicates() {
    let fixture = Fixture::new();
    fixture
        .write(&(line("中文0") + &line("skip") + &line("中文1") + &line("中文2") + "{\"fields\":"));
    let mut cursor = None;
    let mut values = Vec::new();
    loop {
        let mut params = json!({"limit":1,"filter":{"text":"中文","domains":["network"]}});
        if let Some(value) = cursor {
            params["cursor"] = Value::String(value);
        }
        let page = fixture.read(params);
        assert!(!page.gap);
        values.extend(page.entries.iter().map(|v| v.message.clone()));
        cursor = Some(page.cursor);
        if !page.has_more {
            break;
        }
    }
    assert_eq!(values, ["中文0", "中文1", "中文2"]);
    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .open(fixture.path())
        .unwrap();
    writeln!(file, "{{\"message\":\"中文3\",\"domain\":\"network\"}}}}").unwrap();
    drop(file);
    let page =
        fixture.read(json!({"cursor":cursor,"filter":{"text":"中文","domains":["network"]}}));
    assert_eq!(page.entries[0].message, "中文3");
    assert!(!page.has_more);
}
#[test]
fn initial_window_oversized_and_malformed_lines_report_gaps_and_make_progress() {
    let fixture = Fixture::new();
    fixture.write(&("x".repeat(300 * 1024) + "\ninvalid\n" + &line("valid")));
    let page = fixture.read(json!({}));
    assert!(page.gap);
    assert!(!page.reset);
    assert_eq!(page.entries[0].message, "valid");
    assert!(!fixture.read(json!({"cursor":page.cursor})).gap);
    fixture.write(&"x".repeat(70 * 1024));
    let page = fixture.read(json!({}));
    assert!(page.gap);
    assert!(!page.has_more);
    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .open(fixture.path())
        .unwrap();
    write!(file, "\n{}", line("after")).unwrap();
    drop(file);
    let page = fixture.read(json!({"cursor":page.cursor}));
    assert_eq!(page.entries[0].message, "after");
    assert!(page.gap);
}
#[test]
fn replacement_truncation_rotation_and_missing_file_report_reset() {
    let fixture = Fixture::new();
    fixture.write(&line("old"));
    let mut page = fixture.read(json!({}));
    fixture.write(&line("new"));
    page = fixture.read(json!({"cursor":page.cursor}));
    assert!(page.reset && page.gap);
    assert_eq!(page.entries[0].message, "new");
    std::fs::rename(fixture.path(), fixture.dir.join("retired")).unwrap();
    fixture.write(&line("replacement"));
    page = fixture.read(json!({"cursor":page.cursor}));
    assert!(page.reset && page.gap);
    std::fs::write(
        fixture.dir.join("2026-11-12.tunnelde.jsonl.log"),
        line("rotated"),
    )
    .unwrap();
    page = fixture.read(json!({"cursor":page.cursor}));
    assert!(page.reset && page.gap);
    std::fs::remove_file(fixture.path()).unwrap();
    std::fs::remove_file(fixture.dir.join("2026-11-12.tunnelde.jsonl.log")).unwrap();
    page = fixture.read(json!({"cursor":page.cursor}));
    assert!(page.reset && page.gap && page.entries.is_empty());
}
#[test]
fn scan_budget_yields_without_busy_partial_tails() {
    let fixture = Fixture::new();
    fixture.write(&("\n".repeat(3000) + &line("last")));
    let page = fixture.read(json!({}));
    assert!(page.has_more && page.gap);
    let page = fixture.read(json!({"cursor":page.cursor}));
    assert_eq!(page.entries[0].message, "last");
    assert!(!page.has_more);
}
#[test]
fn structured_projection_redacts_credentials_preserves_numbers_and_bounds_utf8() {
    let value = json!({"level":"WARN","target":"tunnelde_lib::update::feeds","fields":{"message":"你好".repeat(10000),"context":json!({"password":"secret","url":"https://a:b@example.com/path?token=secret#fragment","nested":{"token":"private"}}).to_string()}});
    let entry = projection::diagnostic(&serde_json::to_vec(&value).unwrap()).unwrap();
    assert_eq!(entry.domain, "update.feeds");
    assert!(entry.truncated);
    assert!(entry.message.len() <= 16384);
    assert_eq!(entry.fields["context"]["password"], "[REDACTED]");
    assert_eq!(entry.fields["context"]["url"], "https://example.com/path");
    assert!(!serde_json::to_string(&entry).unwrap().contains("private"));
}
#[test]
fn diagnostic_timestamps_are_canonical_for_public_sdk_consumers() {
    for value in [
        "2026-11-11T10:00:00Z",
        "2026-11-11t10:00:00z",
        "2026-11-11 10:00:00+00:00",
    ] {
        let value = json!({"timestamp":value,"fields":{"message":"timestamp"}});
        let entry = projection::diagnostic(&serde_json::to_vec(&value).unwrap()).unwrap();
        assert_eq!(
            entry.timestamp.as_deref(),
            Some("2026-11-11T10:00:00+00:00")
        );
    }
    for value in ["not-a-date", "2026-11-11T10:00:60Z"] {
        let value = json!({"timestamp":value,"fields":{"message":"timestamp"}});
        let entry = projection::diagnostic(&serde_json::to_vec(&value).unwrap()).unwrap();
        assert_eq!(entry.timestamp, None);
    }
}
#[test]
fn operation_retention_and_filtered_pagination_are_explicit() {
    let fixture = Fixture::new();
    for _ in 0..1002 {
        crate::logs::record(&fixture.db, "host.create", Some("host-1"));
    }
    let page = fixture.read(json!({"source":"operations","limit":2}));
    assert!(page.gap && page.has_more);
    assert_eq!(page.entries.len(), 2);
    let next = fixture.read(json!({"source":"operations","cursor":page.cursor,"filter":{}}));
    assert!(!next.gap);
    assert_eq!(next.entries.len(), 100);
    let empty = fixture.read(json!({"source":"operations","filter":{"plugins":["missing"]}}));
    assert!(empty.entries.is_empty());
    assert!(!empty.has_more);
    fixture
        .db
        .with(|db| {
            db.execute("DELETE FROM audit_log", [])?;
            Ok(())
        })
        .unwrap();
    let reset = fixture.read(json!({"source":"operations","cursor":next.cursor}));
    assert!(reset.gap && reset.reset);
}
#[test]
fn cancellation_and_revocation_are_checked_during_io() {
    let fixture = Fixture::new();
    fixture.write(&(line("first") + &line("second")));
    let checks = std::cell::Cell::new(0);
    let result = read(
        &fixture.dir,
        &fixture.db,
        "test",
        serde_json::from_value(json!({})).unwrap(),
        || {
            checks.set(checks.get() + 1);
            if checks.get() >= 4 {
                Err(AppError::validation("pluginSecurity.revoked"))
            } else {
                Ok(())
            }
        },
    );
    assert_eq!(result.err().unwrap().to_string(), "pluginSecurity.revoked");
}
#[cfg(unix)]
#[test]
fn selected_file_open_does_not_follow_links_or_read_special_files() {
    let fixture = Fixture::new();
    let target = fixture.dir.join("outside");
    std::fs::write(&target, line("private")).unwrap();
    std::os::unix::fs::symlink(target, fixture.path()).unwrap();
    assert!(fixture.read(json!({})).entries.is_empty());
}

#[test]
fn emit_public_log_page_for_sdk() {
    let fixture = Fixture::new();
    let decimal = serde_json::json!({"level":"INFO","fields":{"message":"x".repeat(14200),"context":serde_json::json!({"values":vec![0.000001;240]}).to_string()}});
    // Stay inside the initial window so the producer marker remains visible.
    fixture.write(
        &(line("producer→SDK")
            + "{\"timestamp\":\"2026-11-11t10:00:00z\",\"fields\":{\"message\":\"canonical timestamp\"}}\n"
            + &(serde_json::to_string(&decimal).unwrap() + "\n").repeat(14)),
    );
    let page = fixture.read(json!({}));
    if let Some(path) = std::env::var_os("TUNNELDE_LOG_CONTRACT_OUTPUT") {
        std::fs::write(path, serde_json::to_vec(&page).unwrap()).unwrap();
    }
}
