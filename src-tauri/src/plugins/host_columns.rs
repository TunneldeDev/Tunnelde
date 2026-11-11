//! Bounded runtime-owned columns. Cell values are presentation data, not saved hosts.
use super::{
    api::{self, HostContext},
    contributions::Registry,
    security::Lease,
};
use crate::{
    error::{AppError, AppResult},
    state::AppState,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;
use tauri::{AppHandle, Emitter, Manager};

pub const EVENT: &str = "plugin://host-columns-changed";
const INVALID: &str = "plugin.hostList.invalidColumn";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    Text,
    Number,
    Boolean,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Cell {
    pub host_id: String,
    pub value: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tooltip: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Column {
    #[serde(skip)]
    bytes: usize,
    pub id: String,
    pub label: String,
    #[serde(rename = "type")]
    pub kind: Kind,
    #[serde(default = "width")]
    pub width: u16,
    pub cells: Vec<Cell>,
}
fn width() -> u16 {
    140
}
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}
fn plain(text: &str, limit: usize, empty: bool) -> bool {
    (empty
        || !text
            .trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
            .is_empty())
        && text.chars().count() <= limit
        && !text
            .chars()
            .any(|c| c.is_control() || matches!(c,'\u{202a}'..='\u{202e}'|'\u{2066}'..='\u{2069}'))
}
impl Column {
    fn parse(params: Value, host_exists: impl Fn(&str) -> bool) -> AppResult<Self> {
        let mut column: Self =
            serde_json::from_value(params).map_err(|_| AppError::validation(INVALID))?;
        if !valid_id(&column.id)
            || !plain(&column.label, 120, false)
            || !(64..=480).contains(&column.width)
            || column.cells.len() > 256
        {
            return Err(AppError::validation(INVALID));
        }
        let mut hosts = HashSet::new();
        for cell in &column.cells {
            let valid = match column.kind {
                Kind::Text => cell.value.as_str().is_some_and(|v| plain(v, 512, true)),
                Kind::Number => cell.value.as_f64().is_some_and(f64::is_finite),
                Kind::Boolean => cell.value.is_boolean(),
            };
            if !valid
                || !plain(&cell.host_id, 128, false)
                || !hosts.insert(&cell.host_id)
                || cell.tooltip.as_ref().is_some_and(|v| !plain(v, 512, false))
            {
                return Err(AppError::validation(INVALID));
            }
            if !host_exists(&cell.host_id) {
                return Err(AppError::validation("plugin.hostList.hostNotFound"));
            }
        }
        column.bytes = serde_json::to_vec(&column)?.len();
        Ok(column)
    }
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Contribution {
    pub plugin_id: String,
    pub plugin_name: String,
    #[serde(flatten)]
    pub column: Column,
}
#[derive(Clone, Serialize)]
pub struct Snapshot {
    pub revision: u64,
    pub items: Vec<Contribution>,
}
fn authorize(app: &AppHandle, lease: &Lease) -> AppResult<()> {
    let state = app.state::<AppState>();
    for permission in ["hosts.read", "workspace.write"] {
        state.plugins.security.authorize(
            &lease.id,
            &lease.fingerprint,
            &lease.permissions,
            Some(permission),
            Some(lease.generation),
        )?;
    }
    Ok(())
}
#[tauri::command]
pub fn plugin_host_columns_snapshot(app: AppHandle) -> Snapshot {
    let state = app.state::<AppState>();
    let (revision, items) = state
        .plugins
        .host_columns
        .snapshot(|lease| authorize(&app, lease).is_ok());
    Snapshot {
        revision,
        items: items
            .into_iter()
            .map(|owned| Contribution {
                plugin_name: state.plugins.status_bar_name(&owned.lease.id),
                plugin_id: owned.lease.id,
                column: owned.value,
            })
            .collect(),
    }
}
fn emit(app: &AppHandle) {
    let _ = app.emit(EVENT, plugin_host_columns_snapshot(app.clone()));
}
pub(super) fn remove_runtime(app: &AppHandle, owner: &str, generation: impl Fn(u64) -> bool) {
    app.state::<AppState>()
        .plugins
        .host_columns
        .remove_runtime(owner, generation);
    emit(app);
}
pub(super) fn call(context: &HostContext, method: &str, params: Value) -> AppResult<Value> {
    let state = context.app.state::<AppState>();
    let hosts = state
        .db
        .with(crate::db::hosts::list_hosts)?
        .into_iter()
        .map(|host| host.id)
        .chain(
            super::host_sources::plugin_host_sources_snapshot(context.app.clone())
                .items
                .into_iter()
                .flat_map(|source| source.entries.into_iter().map(|entry| entry.host_id)),
        )
        .collect::<HashSet<_>>();
    let lease = Lease {
        id: context.id.clone(),
        fingerprint: context.fingerprint.clone(),
        permissions: context.permissions.clone(),
        generation: context.generation,
    };
    let result = apply(
        &state.plugins.host_columns,
        lease,
        method,
        params,
        |id| hosts.contains(id),
        |lease| authorize(&context.app, lease),
    )?;
    emit(&context.app);
    Ok(result)
}
fn apply(
    registry: &Registry<Column>,
    lease: Lease,
    method: &str,
    params: Value,
    host_exists: impl Fn(&str) -> bool,
    valid: impl Fn(&Lease) -> AppResult<()>,
) -> AppResult<Value> {
    match method {
        "hostList.setColumn" => {
            let column = Column::parse(params, host_exists)?;
            let owner = lease.id.clone();
            registry.upsert_checked(lease, column.id.clone(), column, valid, |values| {
                let total: usize = values.iter().map(|(_, item)| item.bytes).sum();
                let own: usize = values
                    .iter()
                    .filter(|(id, _)| *id == owner)
                    .map(|(_, item)| item.bytes)
                    .sum();
                if total > 4 * 1024 * 1024 || own > 512 * 1024 {
                    return Err(AppError::validation("plugin.hostList.limit"));
                }
                Ok(())
            })?;
            Ok(Value::Null)
        }
        "hostList.removeColumn" => {
            let id: String = api::field(&params, "id")?;
            if !valid_id(&id) {
                return Err(AppError::validation(INVALID));
            }
            Ok(json!(registry.remove(&lease, &id, valid)?))
        }
        _ => Err(AppError::validation("plugin.api.unknownMethod")),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn column() -> Value {
        json!({"id":"cost","label":"Cost","type":"number","cells":[{"hostId":"host","value":0}]})
    }
    fn lease(owner: &str, generation: u64) -> Lease {
        Lease {
            id: owner.into(),
            generation,
            fingerprint: "digest".into(),
            permissions: vec!["hosts.read".into(), "workspace.write".into()],
        }
    }
    #[test]
    fn validates_typed_atomic_columns_and_host_scope() {
        assert!(Column::parse(column(), |_| true).is_ok());
        assert!(Column::parse(column(), |_| false)
            .unwrap_err()
            .to_string()
            .contains("hostNotFound"));
        for (key, value) in [
            ("width", json!(63)),
            ("width", json!(481)),
            ("type", json!("html")),
            ("id", json!("bad:id")),
            ("label", json!("\u{202e}spoof")),
            ("unknown", json!(true)),
        ] {
            let mut bad = column();
            bad[key] = value;
            assert!(Column::parse(bad, |_| true).is_err());
        }
        for value in [json!(null), json!("1"), json!(true), json!({"x":1})] {
            let mut bad = column();
            bad["cells"][0]["value"] = value;
            assert!(Column::parse(bad, |_| true).is_err());
        }
        for kind in ["text", "boolean"] {
            let mut good = column();
            good["type"] = json!(kind);
            good["cells"][0]["value"] = if kind == "text" {
                json!("")
            } else {
                json!(false)
            };
            assert!(Column::parse(good, |_| true).is_ok());
        }
        let mut bad = column();
        bad["cells"] = json!([{"hostId":"host","value":0},{"hostId":"host","value":1}]);
        assert!(Column::parse(bad, |_| true).is_err());
        let mut bad = column();
        bad["cells"] = json!((0..257)
            .map(|n| json!({"hostId":n.to_string(),"value":0}))
            .collect::<Vec<_>>());
        assert!(Column::parse(bad, |_| true).is_err());
    }
    #[test]
    fn ownership_replacement_revocation_and_limits() {
        let registry = Registry::with_limit_error("plugin.hostList.limit");
        for owner in ["a", "b"] {
            apply(
                &registry,
                lease(owner, 1),
                "hostList.setColumn",
                column(),
                |_| true,
                |_| Ok(()),
            )
            .unwrap();
        }
        apply(
            &registry,
            lease("a", 2),
            "hostList.setColumn",
            column(),
            |_| true,
            |_| Ok(()),
        )
        .unwrap();
        registry.remove_runtime("a", |generation| generation < 2);
        assert_eq!(
            apply(
                &registry,
                lease("a", 1),
                "hostList.removeColumn",
                json!({"id":"cost"}),
                |_| true,
                |_| Ok(())
            )
            .unwrap(),
            json!(false)
        );
        let before = registry.snapshot(|_| true).0;
        assert!(apply(
            &registry,
            lease("a", 2),
            "hostList.setColumn",
            column(),
            |_| false,
            |_| Ok(())
        )
        .is_err());
        assert!(apply(
            &registry,
            lease("a", 2),
            "hostList.setColumn",
            column(),
            |_| true,
            |_| Err(AppError::validation("revoked"))
        )
        .is_err());
        assert_eq!(registry.snapshot(|_| true).0, before);
        for n in 0..7 {
            let mut item = column();
            item["id"] = json!(format!("c{n}"));
            apply(
                &registry,
                lease("a", 2),
                "hostList.setColumn",
                item,
                |_| true,
                |_| Ok(()),
            )
            .unwrap();
        }
        let mut item = column();
        item["id"] = json!("overflow");
        assert!(apply(
            &registry,
            lease("a", 2),
            "hostList.setColumn",
            item,
            |_| true,
            |_| Ok(())
        )
        .unwrap_err()
        .to_string()
        .contains("hostList.limit"));
        registry.remove_runtime("a", |_| true);
        assert_eq!(registry.snapshot(|_| true).1.len(), 1);
        assert!(registry.snapshot(|_| false).1.is_empty());
    }

    #[test]
    fn aggregate_byte_quotas_are_atomic_and_replacements_release_capacity() {
        let registry = Registry::with_limit_error("plugin.hostList.limit");
        let large = |id: &str| {
            json!({
                "id":id,"label":"Inventory","type":"text",
                "cells":(0..100).map(|n|json!({"hostId":n.to_string(),"value":"😀".repeat(512),"tooltip":"😀".repeat(512)})).collect::<Vec<_>>()
            })
        };
        let write = |owner: &str, value| {
            apply(
                &registry,
                lease(owner, 1),
                "hostList.setColumn",
                value,
                |_| true,
                |_| Ok(()),
            )
        };
        write("a", large("first")).unwrap();
        let before = registry.snapshot(|_| true).0;
        assert!(write("a", large("second")).is_err());
        assert_eq!(registry.snapshot(|_| true).0, before);
        assert_eq!(registry.snapshot(|_| true).1.len(), 1);
        let mut huge = large("first");
        let cells = huge["cells"].as_array_mut().unwrap();
        cells.extend((100..256).map(
            |n| json!({"hostId":n.to_string(),"value":"😀".repeat(512),"tooltip":"😀".repeat(512)}),
        ));
        assert!(write("a", huge).is_err());
        assert_eq!(registry.snapshot(|_| true).1[0].value.cells.len(), 100);
        write(
            "a",
            json!({"id":"first","label":"Empty","type":"text","cells":[]}),
        )
        .unwrap();
        write("a", large("second")).unwrap();
        for n in 0..9 {
            write(&format!("owner{n}"), large("first")).unwrap();
        }
        let before = registry.snapshot(|_| true).0;
        assert!(write("overflow", large("first")).is_err());
        assert_eq!(registry.snapshot(|_| true).0, before);
        registry.remove_runtime("a", |_| true);
        write("overflow", large("first")).unwrap();
    }

    #[test]
    fn global_column_count_rejects_only_new_entries() {
        let registry = Registry::with_limit_error("plugin.hostList.limit");
        for owner in 0..16 {
            for n in 0..8 {
                let mut value = column();
                value["id"] = json!(format!("col{n}"));
                apply(
                    &registry,
                    lease(&format!("owner{owner}"), 1),
                    "hostList.setColumn",
                    value,
                    |_| true,
                    |_| Ok(()),
                )
                .unwrap();
            }
        }
        assert_eq!(registry.snapshot(|_| true).1.len(), 128);
        assert!(apply(
            &registry,
            lease("overflow", 1),
            "hostList.setColumn",
            column(),
            |_| true,
            |_| Ok(())
        )
        .is_err());
        let mut value = column();
        value["id"] = json!("col0");
        apply(
            &registry,
            lease("owner0", 1),
            "hostList.setColumn",
            value,
            |_| true,
            |_| Ok(()),
        )
        .unwrap();
        assert_eq!(registry.snapshot(|_| true).1.len(), 128);
    }
}
