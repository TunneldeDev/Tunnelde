//! Plugin-owned host metadata. The host validates and persists the public schema;
//! no executable plugin or internal settings shape is needed to edit these values.
use std::collections::{BTreeMap, HashSet};

use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::{
    db::Database,
    error::{AppError, AppResult},
};

const INVALID: &str = "hostFields.invalid";
const MAX_DOCUMENT: usize = 32 * 1024;
const MAX_PLUGIN: i64 = 4 * 1024 * 1024;
const MAX_TOTAL: i64 = 32 * 1024 * 1024;
const MAX_PLUGIN_DOCUMENTS: i64 = 2048;
const MAX_DOCUMENTS: i64 = 16384;
const MAX_REVISION: u64 = 9_007_199_254_740_991;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Schema {
    pub version: u32,
    pub fields: Vec<Field>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Field {
    pub id: String,
    pub label: String,
    #[serde(rename = "type")]
    pub kind: Kind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_length: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub minimum: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub maximum: Option<f64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub options: Vec<Choice>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    Text,
    Number,
    Boolean,
    Select,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Choice {
    pub value: String,
    pub label: String,
}

fn plain(value: &str, max: usize) -> bool {
    !value
        .trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
        .is_empty()
        && value.chars().count() <= max
        && !value.chars().any(|c| {
            c.is_control() || matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
        })
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}

impl Schema {
    pub fn validate(&self) -> AppResult<()> {
        let mut ids = HashSet::new();
        if self.version == 0
            || self.version > 65535
            || self.fields.is_empty()
            || self.fields.len() > 32
        {
            return Err(AppError::validation(INVALID));
        }
        for field in &self.fields {
            let mut choices = HashSet::new();
            if !valid_id(&field.id)
                || !ids.insert(&field.id)
                || !plain(&field.label, 120)
                || field
                    .description
                    .as_ref()
                    .is_some_and(|text| !plain(text, 512))
                || field
                    .max_length
                    .is_some_and(|max| field.kind != Kind::Text || !(1..=4096).contains(&max))
                || field
                    .minimum
                    .is_some_and(|v| field.kind != Kind::Number || !v.is_finite())
                || field
                    .maximum
                    .is_some_and(|v| field.kind != Kind::Number || !v.is_finite())
                || field
                    .minimum
                    .zip(field.maximum)
                    .is_some_and(|(min, max)| min > max)
                || (field.kind == Kind::Select
                    && (field.options.is_empty() || field.options.len() > 64))
                || (field.kind != Kind::Select && !field.options.is_empty())
                || field.options.iter().any(|choice| {
                    !plain(&choice.value, 128)
                        || !plain(&choice.label, 120)
                        || !choices.insert(&choice.value)
                })
            {
                return Err(AppError::validation(INVALID));
            }
        }
        Ok(())
    }

    pub fn digest(&self) -> AppResult<String> {
        Ok(format!("{:x}", Sha256::digest(serde_json::to_vec(self)?)))
    }

    fn validate_values(&self, values: &BTreeMap<String, Value>) -> AppResult<()> {
        self.validate()?;
        if serde_json::to_vec(values)?.len() > MAX_DOCUMENT {
            return Err(AppError::validation("hostFields.limit"));
        }
        for (key, value) in values {
            let field = self
                .fields
                .iter()
                .find(|field| field.id == *key)
                .ok_or_else(|| AppError::validation(INVALID))?;
            let valid = match field.kind {
                Kind::Text => value.as_str().is_some_and(|text| {
                    text.chars().count() <= field.max_length.unwrap_or(4096) && !text.contains('\0')
                }),
                Kind::Number => value.as_f64().is_some_and(|v| {
                    v.is_finite()
                        && field.minimum.is_none_or(|min| v >= min)
                        && field.maximum.is_none_or(|max| v <= max)
                }),
                Kind::Boolean => value.is_boolean(),
                Kind::Select => value
                    .as_str()
                    .is_some_and(|text| field.options.iter().any(|option| option.value == text)),
            };
            if !valid {
                return Err(AppError::validation(format!(
                    "hostFields.invalidValue:{key}"
                )));
            }
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Document {
    pub host_id: String,
    pub revision: u64,
    pub schema_digest: String,
    pub schema_version: u32,
    pub stored_schema_version: Option<u32>,
    pub schema_changed: bool,
    pub values: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, Serialize)]
pub struct Snapshot {
    pub schema: Schema,
    pub document: Document,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Update {
    pub host_id: String,
    pub expected_revision: u64,
    pub schema_digest: String,
    pub values: BTreeMap<String, Value>,
}

fn host_exists(conn: &rusqlite::Connection, host_id: &str) -> AppResult<()> {
    if !conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM hosts WHERE id=?1)",
        [host_id],
        |row| row.get::<_, bool>(0),
    )? {
        return Err(AppError::NotFound("hostFields.hostNotFound".into()));
    }
    Ok(())
}

fn read(
    conn: &rusqlite::Connection,
    plugin_id: &str,
    host_id: &str,
    schema: &Schema,
) -> AppResult<Document> {
    host_exists(conn, host_id)?;
    let saved: Option<(i64,u32,String,String)> = conn.query_row(
        "SELECT revision,schema_version,schema_digest,values_json FROM host_plugin_fields WHERE plugin_id=?1 AND host_id=?2",
        params![plugin_id,host_id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?))
    ).optional()?;
    let digest = schema.digest()?;
    let (revision, stored_schema_version, schema_changed, values) = match saved {
        Some((revision, version, stored, raw)) => (
            revision as u64,
            Some(version),
            stored != digest,
            serde_json::from_str(&raw)?,
        ),
        None => (0, None, false, BTreeMap::new()),
    };
    Ok(Document {
        host_id: host_id.into(),
        revision,
        schema_digest: digest,
        schema_version: schema.version,
        stored_schema_version,
        schema_changed,
        values,
    })
}

pub fn get(db: &Database, plugin_id: &str, host_id: &str, schema: &Schema) -> AppResult<Document> {
    schema.validate()?;
    db.with(|conn| read(conn, plugin_id, host_id, schema))
}

pub fn replace(
    db: &Database,
    plugin_id: &str,
    schema: &Schema,
    update: Update,
) -> AppResult<Document> {
    schema.validate_values(&update.values)?;
    if update.expected_revision >= MAX_REVISION {
        return Err(AppError::validation("hostFields.revisionLimit"));
    }
    if update.schema_digest != schema.digest()? {
        return Err(AppError::validation("hostFields.schemaChanged"));
    }
    db.with(|conn| {
        let tx = conn.unchecked_transaction()?;
        let previous = read(&tx,plugin_id,&update.host_id,schema)?;
        if previous.revision != update.expected_revision { return Err(AppError::validation("hostFields.conflict")); }
        let raw = serde_json::to_string(&update.values)?;
        if previous.revision == 0 {
            let (own_count,total_count): (i64,i64) = tx.query_row("SELECT COALESCE(SUM(CASE WHEN plugin_id=?1 THEN 1 ELSE 0 END),0),COUNT(*) FROM host_plugin_fields", [plugin_id], |row| Ok((row.get(0)?,row.get(1)?)))?;
            if own_count >= MAX_PLUGIN_DOCUMENTS || total_count >= MAX_DOCUMENTS {
                return Err(AppError::validation("hostFields.limit"));
            }
        }
        let old_bytes: i64 = tx.query_row("SELECT COALESCE(SUM(length(CAST(values_json AS BLOB))),0) FROM host_plugin_fields WHERE plugin_id=?1 AND host_id=?2", params![plugin_id,update.host_id], |row| row.get(0))?;
        let (own,total): (i64,i64) = tx.query_row("SELECT COALESCE(SUM(CASE WHEN plugin_id=?1 THEN length(CAST(values_json AS BLOB)) ELSE 0 END),0), COALESCE(SUM(length(CAST(values_json AS BLOB))),0) FROM host_plugin_fields", [plugin_id], |row| Ok((row.get(0)?,row.get(1)?)))?;
        // Retained databases can already exceed a quota after schema changes.
        // Existing values must still be shrinkable so users can recover space.
        let growth = raw.len() as i64 - old_bytes;
        if growth > 0 && (own + growth > MAX_PLUGIN || total + growth > MAX_TOTAL) {
            return Err(AppError::validation("hostFields.limit"));
        }
        tx.execute("INSERT INTO host_plugin_fields (plugin_id,host_id,revision,schema_version,schema_digest,values_json) VALUES (?1,?2,?3,?4,?5,?6) ON CONFLICT(plugin_id,host_id) DO UPDATE SET revision=excluded.revision,schema_version=excluded.schema_version,schema_digest=excluded.schema_digest,values_json=excluded.values_json", params![plugin_id,update.host_id,(previous.revision+1) as i64,schema.version,update.schema_digest,raw])?;
        let next = read(&tx,plugin_id,&update.host_id,schema)?;
        tx.commit()?;
        Ok(next)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn schema() -> Schema {
        serde_json::from_value(json!({"version":1,"fields":[
            {"id":"owner","label":"Owner","type":"text","maxLength":16},
            {"id":"cost","label":"Cost","type":"number","minimum":0,"maximum":100},
            {"id":"managed","label":"Managed","type":"boolean"},
            {"id":"tier","label":"Tier","type":"select","options":[{"value":"prod","label":"Production"},{"value":"dev","label":"Development"}]}
        ]})).unwrap()
    }
    fn host(db: &Database) -> String {
        let input = serde_json::from_value::<crate::models::HostInput>(
            json!({"name":"Test", "host":"192.0.2.1"}),
        )
        .unwrap()
        .validate()
        .unwrap();
        db.with(|conn| Ok(crate::db::hosts::create_host(conn, &input)?.id))
            .unwrap()
    }
    fn update(host: &str, schema: &Schema, revision: u64, values: Value) -> Update {
        Update {
            host_id: host.into(),
            expected_revision: revision,
            schema_digest: schema.digest().unwrap(),
            values: serde_json::from_value(values).unwrap(),
        }
    }

    #[test]
    fn schemas_reject_unknown_keys_duplicates_invalid_ranges_and_invisible_labels() {
        let source = serde_json::to_value(schema()).unwrap();
        let mut cases = Vec::new();
        let mut bad = source.clone();
        bad["fields"][0]["secret"] = true.into();
        cases.push(bad);
        let mut bad = source.clone();
        bad["version"] = 0.into();
        cases.push(bad);
        let mut bad = source.clone();
        bad["fields"][1]["id"] = "owner".into();
        cases.push(bad);
        let mut bad = source.clone();
        bad["fields"][0]["label"] = "\u{202e}spoof".into();
        cases.push(bad);
        let mut bad = source.clone();
        bad["fields"][0]["maxLength"] = 0.into();
        cases.push(bad);
        let mut bad = source.clone();
        bad["fields"][0]["minimum"] = 0.into();
        cases.push(bad);
        let mut bad = source.clone();
        bad["fields"][1]["maximum"] = (-1).into();
        cases.push(bad);
        let mut bad = source.clone();
        bad["fields"][3]["options"][1]["value"] = "prod".into();
        cases.push(bad);
        let mut bad = source.clone();
        bad["fields"][3]["options"] = json!([]);
        cases.push(bad);
        let mut bad = source.clone();
        bad["fields"] = json!(vec![source["fields"][0].clone(); 33]);
        cases.push(bad);
        for bad in cases {
            assert!(serde_json::from_value::<Schema>(bad)
                .map_or(true, |schema| schema.validate().is_err()));
        }
        let mut unicode = schema();
        unicode.fields[0].label = "😀".repeat(120);
        assert!(unicode.validate().is_ok());
        unicode.fields[0].label.push('😀');
        assert!(unicode.validate().is_err());
    }

    #[test]
    fn typed_replacements_are_isolated_revisioned_and_host_deletion_cascades() {
        let db = Database::in_memory().unwrap();
        let a = host(&db);
        let b = host(&db);
        let schema = schema();
        assert_eq!(get(&db, "one", &a, &schema).unwrap().revision, 0);
        let saved = replace(
            &db,
            "one",
            &schema,
            update(
                &a,
                &schema,
                0,
                json!({"owner":"😀","cost":0,"managed":false,"tier":"prod"}),
            ),
        )
        .unwrap();
        assert_eq!(saved.revision, 1);
        assert_eq!(saved.values["managed"], false);
        assert_eq!(saved.values["cost"], 0);
        assert!(get(&db, "two", &a, &schema).unwrap().values.is_empty());
        assert!(get(&db, "one", &b, &schema).unwrap().values.is_empty());
        assert!(
            replace(&db, "one", &schema, update(&a, &schema, 0, json!({})))
                .unwrap_err()
                .to_string()
                .contains("conflict")
        );
        let cleared = replace(&db, "one", &schema, update(&a, &schema, 1, json!({}))).unwrap();
        assert_eq!(cleared.revision, 2);
        assert!(replace(&db, "one", &schema, update(&a, &schema, 0, json!({}))).is_err());
        db.with(|conn| crate::db::hosts::delete_host(conn, &a))
            .unwrap();
        assert!(get(&db, "one", &a, &schema)
            .unwrap_err()
            .to_string()
            .contains("hostNotFound"));
        db.with(|conn| {
            assert_eq!(
                conn.query_row("SELECT COUNT(*) FROM host_plugin_fields", [], |row| row
                    .get::<_, i64>(0))?,
                0
            );
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn schema_drift_preserves_old_values_until_explicit_valid_migration() {
        let db = Database::in_memory().unwrap();
        let host = host(&db);
        let old = schema();
        replace(
            &db,
            "one",
            &old,
            update(&host, &old, 0, json!({"owner":"old","tier":"prod"})),
        )
        .unwrap();
        let mut current = old.clone();
        current.version = 2;
        current.fields.retain(|f| f.id != "owner");
        let drift = get(&db, "one", &host, &current).unwrap();
        assert!(drift.schema_changed);
        assert_eq!(drift.stored_schema_version, Some(1));
        assert_eq!(drift.values["owner"], "old");
        assert!(replace(
            &db,
            "one",
            &current,
            update(&host, &old, 1, json!({"tier":"dev"}))
        )
        .unwrap_err()
        .to_string()
        .contains("schemaChanged"));
        assert!(replace(
            &db,
            "one",
            &current,
            update(&host, &current, 1, json!({"owner":"old"}))
        )
        .is_err());
        assert_eq!(
            get(&db, "one", &host, &current).unwrap().values["owner"],
            "old"
        );
        let migrated = replace(
            &db,
            "one",
            &current,
            update(&host, &current, 1, json!({"tier":"dev"})),
        )
        .unwrap();
        assert!(!migrated.schema_changed);
        assert_eq!(migrated.revision, 2);
        assert_eq!(migrated.stored_schema_version, Some(2));
    }

    #[test]
    fn invalid_values_fail_without_partial_write_and_limits_count_utf8_bytes() {
        let db = Database::in_memory().unwrap();
        let host = host(&db);
        let schema = schema();
        for values in [
            json!({"owner":null}),
            json!({"cost":"1"}),
            json!({"cost":101}),
            json!({"cost":-1}),
            json!({"managed":0}),
            json!({"tier":"other"}),
            json!({"undeclared":"x"}),
            json!({"owner":"\0"}),
            json!({"owner":"😀".repeat(17)}),
        ] {
            assert!(replace(&db, "one", &schema, update(&host, &schema, 0, values)).is_err());
            assert_eq!(get(&db, "one", &host, &schema).unwrap().revision, 0);
        }
        assert!(replace(
            &db,
            "one",
            &schema,
            update("missing", &schema, 0, json!({}))
        )
        .is_err());
        let mut large = schema.clone();
        large.fields = (0..3)
            .map(|n| Field {
                id: format!("f{n}"),
                label: "Text".into(),
                kind: Kind::Text,
                description: None,
                max_length: Some(4096),
                minimum: None,
                maximum: None,
                options: vec![],
            })
            .collect();
        assert!(replace(
            &db,
            "one",
            &large,
            update(
                &host,
                &large,
                0,
                json!({"f0":"😀".repeat(4096),"f1":"😀".repeat(4096),"f2":"😀".repeat(4096)})
            )
        )
        .unwrap_err()
        .to_string()
        .contains("limit"));
    }

    #[test]
    fn retained_documents_have_bounded_count_and_revision_exhaustion_does_not_reset() {
        let db = Database::in_memory().unwrap();
        let host = host(&db);
        let schema = schema();
        replace(&db, "one", &schema, update(&host, &schema, 0, json!({}))).unwrap();
        db.with(|conn| {
            conn.execute(
                "UPDATE host_plugin_fields SET revision=?1",
                [MAX_REVISION as i64],
            )?;
            Ok(())
        })
        .unwrap();
        assert!(replace(
            &db,
            "one",
            &schema,
            update(&host, &schema, MAX_REVISION, json!({}))
        )
        .unwrap_err()
        .to_string()
        .contains("revisionLimit"));
        assert_eq!(
            get(&db, "one", &host, &schema).unwrap().revision,
            MAX_REVISION
        );
    }

    #[test]
    fn simultaneous_writers_cannot_both_commit_the_same_revision() {
        let db = std::sync::Arc::new(Database::in_memory().unwrap());
        let host = host(&db);
        let schema = schema();
        let gate = std::sync::Arc::new(std::sync::Barrier::new(3));
        let handles: Vec<_> = ["Alice", "Bob"]
            .into_iter()
            .map(|owner| {
                let (db, host, schema, gate) =
                    (db.clone(), host.clone(), schema.clone(), gate.clone());
                std::thread::spawn(move || {
                    gate.wait();
                    replace(
                        &db,
                        "one",
                        &schema,
                        update(&host, &schema, 0, json!({"owner":owner})),
                    )
                })
            })
            .collect();
        gate.wait();
        assert_eq!(
            handles
                .into_iter()
                .map(|handle| handle.join().unwrap().is_ok())
                .filter(|success| *success)
                .count(),
            1
        );
        assert_eq!(get(&db, "one", &host, &schema).unwrap().revision, 1);
    }

    #[test]
    fn aggregate_quotas_rollback_and_existing_documents_can_still_be_cleared() {
        let db = Database::in_memory().unwrap();
        let target = host(&db);
        let schema = schema();
        // Seed retained documents from an older (larger text) schema. The new
        // schema cannot silently discard these values to recover quota.
        db.with(|conn| {
            conn.execute_batch("WITH RECURSIVE ids(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM ids WHERE n<2048) INSERT INTO hosts(id,name,host,created_at,updated_at) SELECT 'quota-'||n,'Quota','192.0.2.1',0,0 FROM ids;")?;
            let tx = conn.unchecked_transaction()?;
            let raw = serde_json::to_string(&json!({"owner":"x".repeat(4096)}))?;
            for n in 1..=1024 {
                tx.execute("INSERT INTO host_plugin_fields VALUES ('one',?1,1,1,'old',?2)", params![format!("quota-{n}"),raw])?;
            }
            tx.commit()?; Ok(())
        }).unwrap();
        assert!(replace(
            &db,
            "one",
            &schema,
            update(&target, &schema, 0, json!({"owner":"new"}))
        )
        .unwrap_err()
        .to_string()
        .contains("limit"));
        assert_eq!(get(&db, "one", &target, &schema).unwrap().revision, 0);
        for n in 1..=4 {
            replace(
                &db,
                "one",
                &schema,
                update(&format!("quota-{n}"), &schema, 1, json!({})),
            )
            .unwrap();
        }
        assert!(replace(
            &db,
            "one",
            &schema,
            update(&target, &schema, 0, json!({"owner":"new"}))
        )
        .is_ok());
        db.with(|conn| {
            conn.execute("DELETE FROM host_plugin_fields",[])?;
            conn.execute("INSERT INTO host_plugin_fields SELECT 'one',id,1,1,'old','{}' FROM hosts WHERE id LIKE 'quota-%'",[])?;
            Ok(())
        }).unwrap();
        assert!(
            replace(&db, "one", &schema, update(&target, &schema, 0, json!({})))
                .unwrap_err()
                .to_string()
                .contains("limit")
        );
        assert!(replace(
            &db,
            "one",
            &schema,
            update("quota-1", &schema, 1, json!({}))
        )
        .is_ok());
        // Other plugin IDs have separate byte/count allowances, but share the
        // total allowance. All documents remain attached to existing hosts.
        db.with(|conn| {
            let tx = conn.unchecked_transaction()?;
            let raw = serde_json::to_string(&json!({"owner":"x".repeat(4096)}))?;
            tx.execute("DELETE FROM host_plugin_fields",[])?;
            for n in 0..8 {
                tx.execute("INSERT INTO host_plugin_fields SELECT ?1,id,1,1,'old',?2 FROM hosts WHERE id LIKE 'quota-%' AND CAST(substr(id,7) AS INTEGER)<=1024", params![format!("plugin-{n}"),raw])?;
            }
            tx.commit()?; Ok(())
        }).unwrap();
        assert!(replace(
            &db,
            "fresh",
            &schema,
            update(&target, &schema, 0, json!({}))
        )
        .unwrap_err()
        .to_string()
        .contains("limit"));
        assert_eq!(get(&db, "fresh", &target, &schema).unwrap().revision, 0);
        replace(
            &db,
            "plugin-0",
            &schema,
            update("quota-1", &schema, 1, json!({})),
        )
        .unwrap();
    }
}
