//! Additive host-list presentation, independent of saved hosts and UI layout.
use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use super::{
    api::{self, HostContext},
    contributions::Registry,
    security::Lease,
};
use crate::{
    error::{AppError, AppResult},
    state::AppState,
};

pub const EVENT: &str = "plugin://host-list-changed";
const INVALID: &str = "plugin.hostList.invalidDecoration";

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Tone {
    #[default]
    Neutral,
    Info,
    Success,
    Warning,
    Error,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Icon {
    Server,
    Cloud,
    Container,
    Database,
    Globe,
    Code,
    Terminal,
    Shield,
    Key,
    Activity,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Decoration {
    pub host_id: String,
    pub badge: Option<String>,
    pub description: Option<String>,
    pub tooltip: Option<String>,
    pub icon: Option<Icon>,
    #[serde(default)]
    pub tone: Tone,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct DecorationSet {
    pub id: String,
    #[serde(default)]
    pub priority: i32,
    pub decorations: Vec<Decoration>,
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

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
}

impl DecorationSet {
    fn parse(params: Value, host_exists: impl Fn(&str) -> bool) -> AppResult<Self> {
        let set: Self =
            serde_json::from_value(params).map_err(|_| AppError::validation(INVALID))?;
        if !valid_id(&set.id)
            || !(-1000..=1000).contains(&set.priority)
            || set.decorations.len() > 256
        {
            return Err(AppError::validation(INVALID));
        }
        let mut ids = HashSet::new();
        for item in &set.decorations {
            if !plain(&item.host_id, 128)
                || !ids.insert(&item.host_id)
                || item.badge.as_ref().is_some_and(|v| !plain(v, 16))
                || item.description.as_ref().is_some_and(|v| !plain(v, 160))
                || item.tooltip.as_ref().is_some_and(|v| !plain(v, 512))
                || (item.badge.is_none() && item.description.is_none() && item.icon.is_none())
            {
                return Err(AppError::validation(INVALID));
            }
            if !host_exists(&item.host_id) {
                return Err(AppError::validation("plugin.hostList.hostNotFound"));
            }
        }
        Ok(set)
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Contribution {
    pub plugin_id: String,
    pub plugin_name: String,
    #[serde(flatten)]
    pub set: DecorationSet,
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
pub fn plugin_host_list_snapshot(app: AppHandle) -> Snapshot {
    let state = app.state::<AppState>();
    let (revision, items) = state
        .plugins
        .host_list
        .snapshot(|lease| authorize(&app, lease).is_ok());
    Snapshot {
        revision,
        items: items
            .into_iter()
            .map(|owned| Contribution {
                plugin_name: state.plugins.status_bar_name(&owned.lease.id),
                plugin_id: owned.lease.id,
                set: owned.value,
            })
            .collect(),
    }
}

fn emit(app: &AppHandle) {
    let _ = app.emit(EVENT, plugin_host_list_snapshot(app.clone()));
}

pub(super) fn remove_runtime(app: &AppHandle, id: &str, generation: impl Fn(u64) -> bool) {
    app.state::<AppState>()
        .plugins
        .host_list
        .remove_runtime(id, generation);
    emit(app);
}

pub(super) fn call(context: &HostContext, method: &str, params: Value) -> AppResult<Value> {
    let app = &context.app;
    let state = app.state::<AppState>();
    let lease = Lease {
        id: context.id.clone(),
        fingerprint: context.fingerprint.clone(),
        permissions: context.permissions.clone(),
        generation: context.generation,
    };
    let hosts = if method == "hostList.setDecorations" {
        state
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
            .collect::<HashSet<_>>()
    } else {
        HashSet::new()
    };
    let result = apply(
        &state.plugins.host_list,
        lease,
        method,
        params,
        |id| hosts.contains(id),
        |lease| authorize(app, lease),
    )?;
    emit(app);
    Ok(result)
}

fn apply(
    registry: &Registry<DecorationSet>,
    lease: Lease,
    method: &str,
    params: Value,
    host_exists: impl Fn(&str) -> bool,
    valid: impl Fn(&Lease) -> AppResult<()>,
) -> AppResult<Value> {
    match method {
        "hostList.setDecorations" => {
            let set = DecorationSet::parse(params, host_exists)?;
            if set.decorations.is_empty() {
                registry.remove(&lease, &set.id, valid)?;
            } else {
                registry.upsert(lease, set.id.clone(), set, valid)?;
            }
            Ok(Value::Null)
        }
        "hostList.removeDecorations" => {
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
    fn lease(id: &str, generation: u64) -> Lease {
        Lease {
            id: id.into(),
            fingerprint: "digest".into(),
            permissions: vec!["hosts.read".into(), "workspace.write".into()],
            generation,
        }
    }
    fn params() -> Value {
        json!({"id":"health", "decorations":[{"hostId":"host", "badge":"PROD", "description":"Deployment ready", "tone":"success", "icon":"server"}]})
    }

    #[test]
    fn validates_atomic_batches_and_rejects_unknown_hosts() {
        assert!(DecorationSet::parse(params(), |_| true).is_ok());
        assert_eq!(
            DecorationSet::parse(params(), |_| false)
                .unwrap_err()
                .to_string(),
            "plugin.hostList.hostNotFound"
        );
        for (field, value) in [
            ("badge", json!("x".repeat(17))),
            ("badge", json!("\u{202e}PROD")),
            ("description", json!("line\nbreak")),
            ("description", json!(" ")),
            ("tooltip", json!("x".repeat(513))),
            ("icon", json!("http://example.test/icon.svg")),
            ("tone", json!("#ffffff")),
            ("hostId", json!("")),
        ] {
            let mut bad = params();
            bad["decorations"][0][field] = value;
            assert!(
                DecorationSet::parse(bad, |_| true).is_err(),
                "accepted {field}"
            );
        }
        let mut bad = params();
        bad["priority"] = json!(1001);
        assert!(DecorationSet::parse(bad, |_| true).is_err());
        let mut bad = params();
        bad["decorations"] = json!([{"hostId":"host","tooltip":"only tooltip"}]);
        assert!(DecorationSet::parse(bad, |_| true).is_err());
        let mut bad = params();
        let duplicate = bad["decorations"][0].clone();
        bad["decorations"].as_array_mut().unwrap().push(duplicate);
        assert!(DecorationSet::parse(bad, |_| true).is_err());
        let mut bad = params();
        bad["decorations"] = json!((0..257)
            .map(|id| json!({"hostId":id.to_string(),"badge":"x"}))
            .collect::<Vec<_>>());
        assert!(DecorationSet::parse(bad, |_| true).is_err());
    }

    #[test]
    fn replacement_revocation_and_runtime_boundaries_preserve_other_owners() {
        let registry = Registry::with_limit_error("plugin.hostList.limit");
        for owner in ["a", "b"] {
            apply(
                &registry,
                lease(owner, 1),
                "hostList.setDecorations",
                params(),
                |_| true,
                |_| Ok(()),
            )
            .unwrap();
        }
        apply(
            &registry,
            lease("a", 2),
            "hostList.setDecorations",
            params(),
            |_| true,
            |_| Ok(()),
        )
        .unwrap();
        registry.remove_runtime("a", |generation| generation < 2);
        assert_eq!(
            apply(
                &registry,
                lease("a", 1),
                "hostList.removeDecorations",
                json!({"id":"health"}),
                |_| false,
                |_| Ok(())
            )
            .unwrap(),
            json!(false)
        );
        assert_eq!(registry.snapshot(|_| true).1.len(), 2);
        let denied = |_: &Lease| Err(AppError::validation("revoked"));
        assert!(apply(
            &registry,
            lease("a", 2),
            "hostList.setDecorations",
            params(),
            |_| true,
            denied
        )
        .is_err());
        assert!(apply(
            &registry,
            lease("a", 2),
            "hostList.removeDecorations",
            json!({"id":"health"}),
            |_| true,
            denied
        )
        .is_err());
        assert_eq!(registry.snapshot(|_| true).1.len(), 2);
        apply(
            &registry,
            lease("a", 2),
            "hostList.setDecorations",
            json!({"id":"health","decorations":[]}),
            |_| false,
            |_| Ok(()),
        )
        .unwrap();
        assert_eq!(registry.snapshot(|_| true).1.len(), 1);
        assert!(registry.snapshot(|_| false).1.is_empty());
    }
    #[test]
    fn invalid_batch_is_atomic_and_quotas_use_domain_errors() {
        let registry = Registry::with_limit_error("plugin.hostList.limit");
        apply(
            &registry,
            lease("a", 1),
            "hostList.setDecorations",
            params(),
            |_| true,
            |_| Ok(()),
        )
        .unwrap();
        let mut bad = params();
        bad["decorations"]
            .as_array_mut()
            .unwrap()
            .push(json!({"hostId":"gone","badge":"NEW"}));
        assert!(apply(
            &registry,
            lease("a", 1),
            "hostList.setDecorations",
            bad,
            |id| id == "host",
            |_| Ok(())
        )
        .is_err());
        assert_eq!(registry.snapshot(|_| true).1[0].value.decorations.len(), 1);
        for id in 0..7 {
            let mut value = params();
            value["id"] = json!(format!("collection-{id}"));
            apply(
                &registry,
                lease("a", 1),
                "hostList.setDecorations",
                value,
                |_| true,
                |_| Ok(()),
            )
            .unwrap();
        }
        let mut overflow = params();
        overflow["id"] = json!("overflow");
        assert_eq!(
            apply(
                &registry,
                lease("a", 1),
                "hostList.setDecorations",
                overflow,
                |_| true,
                |_| Ok(())
            )
            .unwrap_err()
            .to_string(),
            "plugin.hostList.limit"
        );
        apply(
            &registry,
            lease("a", 1),
            "hostList.setDecorations",
            params(),
            |_| true,
            |_| Ok(()),
        )
        .unwrap();
        assert_eq!(registry.snapshot(|_| true).1.len(), 8);
    }
}
