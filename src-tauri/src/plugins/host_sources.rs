//! Runtime-owned discovery data. Credentials and saved host records remain user-owned.
use super::{api::HostContext, contributions::Registry, security::Lease};
use crate::{
    error::{AppError, AppResult},
    models::Host,
    state::AppState,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use tauri::{AppHandle, Emitter, Manager};

const INVALID: &str = "plugin.hostSources.invalid";
pub const EVENT: &str = "plugin://host-sources-changed";
pub const PREFIX: &str = "source:";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Entry {
    pub id: String,
    pub name: String,
    pub host: String,
    #[serde(default = "port")]
    pub port: u16,
    pub username: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub note: Option<String>,
}
fn port() -> u16 {
    22
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Source {
    pub id: String,
    pub label: String,
    pub entries: Vec<Entry>,
}
fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}
fn plain(value: &str, max: usize) -> bool {
    !value.trim().is_empty()
        && value.chars().count() <= max
        && !value.chars().any(|c| {
            c.is_control() || matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
        })
}
impl Source {
    fn parse(value: Value) -> AppResult<Self> {
        if serde_json::to_vec(&value)?.len() > 256 * 1024 {
            return Err(AppError::validation(INVALID));
        }
        let source: Self =
            serde_json::from_value(value).map_err(|_| AppError::validation(INVALID))?;
        let mut ids = HashSet::new();
        if !valid_id(&source.id) || !plain(&source.label, 120) || source.entries.len() > 256 {
            return Err(AppError::validation(INVALID));
        }
        for entry in &source.entries {
            if !valid_id(&entry.id)
                || !ids.insert(&entry.id)
                || !plain(&entry.name, 80)
                || !plain(&entry.host, 255)
                || entry
                    .host
                    .chars()
                    .any(|c| c.is_whitespace() || matches!(c, '/' | '\\' | '"' | '\''))
                || entry.port == 0
                || !plain(&entry.username, 64)
                || entry.tags.len() > 12
                || entry.tags.iter().any(|tag| !plain(tag, 24))
                || entry.note.as_ref().is_some_and(|note| !plain(note, 2000))
            {
                return Err(AppError::validation(INVALID));
            }
        }
        Ok(source)
    }
}

/// The complete public endpoint identity is content-bound. A stale dialog can
/// never address a replacement endpoint under the same source/entry key.
fn host_id(owner: &str, source: &str, entry: &Entry) -> String {
    let encoded = serde_json::to_vec(&(owner, source, entry)).expect("serializable source entry");
    format!("{PREFIX}{:x}", Sha256::digest(encoded))
}
fn host(owner: &str, source: &str, entry: &Entry) -> Host {
    Host {
        id: host_id(owner, source, entry),
        group_id: None,
        name: entry.name.clone(),
        host: entry.host.clone(),
        port: entry.port,
        username: entry.username.clone(),
        auth_method: "password".into(),
        key_path: None,
        favorite: false,
        color: None,
        tags: entry.tags.clone(),
        note: entry.note.clone(),
        sort_order: 0,
        last_used_at: None,
        created_at: 0,
        updated_at: 0,
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceEntry {
    pub host_id: String,
    #[serde(flatten)]
    pub entry: Entry,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Contribution {
    pub plugin_id: String,
    pub plugin_name: String,
    pub id: String,
    pub label: String,
    pub entries: Vec<SourceEntry>,
}
#[derive(Clone, Serialize)]
pub struct Snapshot {
    pub revision: u64,
    pub items: Vec<Contribution>,
}
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PageRequest {
    #[serde(default)]
    offset: usize,
    revision: Option<u64>,
}
fn page(snapshot: Snapshot, params: Value) -> AppResult<Value> {
    let request: PageRequest =
        serde_json::from_value(params).map_err(|_| AppError::validation(INVALID))?;
    if request
        .revision
        .is_some_and(|revision| revision != snapshot.revision)
    {
        return Err(AppError::validation("plugin.hostSources.changed"));
    }
    let total = snapshot.items.len();
    if request.offset > total || (request.offset != 0 && request.revision.is_none()) {
        return Err(AppError::validation(INVALID));
    }
    let next = request.offset + usize::from(request.offset < total);
    Ok(json!({"revision":snapshot.revision,"total":total,
        "nextOffset":(next < total).then_some(next),
        "items":snapshot.items.into_iter().skip(request.offset).take(1).collect::<Vec<_>>()}))
}
fn authorize(app: &AppHandle, lease: &Lease) -> AppResult<()> {
    let state = app.state::<AppState>();
    for permission in ["hosts.read", "hosts.write"] {
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
pub fn plugin_host_sources_snapshot(app: AppHandle) -> Snapshot {
    let state = app.state::<AppState>();
    let (revision, values) = state
        .plugins
        .host_sources
        .snapshot(|lease| authorize(&app, lease).is_ok());
    Snapshot {
        revision,
        items: values
            .into_iter()
            .map(|owned| Contribution {
                plugin_name: state.plugins.status_bar_name(&owned.lease.id),
                entries: owned
                    .value
                    .entries
                    .iter()
                    .map(|entry| SourceEntry {
                        host_id: host_id(&owned.lease.id, &owned.value.id, entry),
                        entry: entry.clone(),
                    })
                    .collect(),
                plugin_id: owned.lease.id,
                id: owned.value.id,
                label: owned.value.label,
            })
            .collect(),
    }
}
pub(crate) fn resolve(app: &AppHandle, id: &str) -> AppResult<Host> {
    let state = app.state::<AppState>();
    let (_, values) = state
        .plugins
        .host_sources
        .snapshot(|lease| authorize(app, lease).is_ok());
    for owned in values {
        for entry in &owned.value.entries {
            if host_id(&owned.lease.id, &owned.value.id, entry) == id {
                return Ok(host(&owned.lease.id, &owned.value.id, entry));
            }
        }
    }
    Err(AppError::validation("plugin.hostSources.unavailable"))
}
fn emit(app: &AppHandle) {
    let snapshot = plugin_host_sources_snapshot(app.clone());
    let revision = snapshot.revision;
    let _ = app.emit(EVENT, snapshot);
    let _ = app.emit(
        "plugin://domain-changed",
        json!({"domain":"hosts.sources","revision":revision}),
    );
}
pub(super) fn remove_runtime(app: &AppHandle, owner: &str, generation: impl Fn(u64) -> bool) {
    app.state::<AppState>()
        .plugins
        .host_sources
        .remove_runtime(owner, generation);
    emit(app);
}
pub(super) fn call(context: &HostContext, method: &str, params: Value) -> AppResult<Value> {
    if method == "hosts.sourcesSnapshot" {
        return page(plugin_host_sources_snapshot(context.app.clone()), params);
    }
    let state = context.app.state::<AppState>();
    let lease = Lease {
        id: context.id.clone(),
        fingerprint: context.fingerprint.clone(),
        permissions: context.permissions.clone(),
        generation: context.generation,
    };
    let result = apply(
        &state.plugins.host_sources,
        lease,
        method,
        params,
        |lease| authorize(&context.app, lease),
    )?;
    let action = match method {
        "hosts.setSource" => "hosts.setSource",
        "hosts.removeSource" => "hosts.removeSource",
        _ => unreachable!("apply rejects unknown source methods"),
    };
    crate::logs::record(&state.db, action, Some(&context.id));
    tracing::info!(plugin_id = %context.id, operation = method, "host discovery source changed");
    emit(&context.app);
    Ok(result)
}
fn apply(
    registry: &Registry<Source>,
    lease: Lease,
    method: &str,
    params: Value,
    valid: impl Fn(&Lease) -> AppResult<()>,
) -> AppResult<Value> {
    match method {
        "hosts.setSource" => {
            let source = Source::parse(params)?;
            let owner = lease.id.clone();
            registry.upsert_checked(lease, source.id.clone(), source, valid, |values| {
                let mut total = 0;
                let mut own = 0;
                let mut bytes = 0;
                for (id, value) in values {
                    total += value.entries.len();
                    if id == owner {
                        own += value.entries.len();
                    }
                    bytes += serde_json::to_vec(value)?.len();
                }
                if total > 4096 || own > 512 || bytes > 4 * 1024 * 1024 {
                    return Err(AppError::validation("plugin.hostSources.limit"));
                }
                Ok(())
            })?;
            Ok(Value::Null)
        }
        "hosts.removeSource" => {
            let id: String = super::api::field(&params, "id")?;
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
    fn source() -> Value {
        json!({"id":"inventory","label":"Inventory","entries":[{"id":"one","name":"Server","host":"127.0.0.1","username":"tester"}]})
    }
    fn lease(owner: &str, generation: u64) -> Lease {
        Lease {
            id: owner.into(),
            fingerprint: "digest".into(),
            permissions: vec!["hosts.read".into(), "hosts.write".into()],
            generation,
        }
    }
    #[test]
    fn discovery_pages_are_bounded_and_require_the_original_revision() {
        let snapshot = || Snapshot {
            revision: 7,
            items: (0..3)
                .map(|n| Contribution {
                    plugin_id: "inventory".into(),
                    plugin_name: "Inventory".into(),
                    id: n.to_string(),
                    label: "Nodes".into(),
                    entries: vec![],
                })
                .collect(),
        };
        let first = page(snapshot(), json!({})).unwrap();
        assert_eq!(first["items"].as_array().unwrap().len(), 1);
        assert_eq!(first["total"], 3);
        assert_eq!(first["nextOffset"], 1);
        assert_eq!(
            page(snapshot(), json!({"offset":2,"revision":7})).unwrap()["nextOffset"],
            Value::Null
        );
        assert_eq!(
            page(snapshot(), json!({"offset":3,"revision":7})).unwrap()["items"],
            json!([])
        );
        assert!(page(snapshot(), json!({"offset":1})).is_err());
        assert!(page(snapshot(), json!({"offset":4,"revision":7})).is_err());
        assert!(page(snapshot(), json!({"offset":1,"revision":6}))
            .unwrap_err()
            .to_string()
            .contains("changed"));
        assert!(page(snapshot(), json!({"offset":-1})).is_err());
        assert!(page(snapshot(), json!({"confirmed":true})).is_err());
    }
    #[test]
    fn endpoint_ids_cannot_be_retargeted_or_impersonate_saved_hosts() {
        let entry = Source::parse(source()).unwrap().entries.remove(0);
        let identity = host_id("a", "inventory", &entry);
        assert!(identity.starts_with(PREFIX));
        assert_eq!(identity, host_id("a", "inventory", &entry));
        assert_ne!(identity, host_id("b", "inventory", &entry));
        assert_ne!(identity, host_id("a", "other", &entry));
        for key in ["host", "port", "username", "name", "id"] {
            let mut changed = serde_json::to_value(&entry).unwrap();
            changed[key] = if key == "port" {
                json!(2222)
            } else {
                json!("other")
            };
            assert_ne!(
                identity,
                host_id("a", "inventory", &serde_json::from_value(changed).unwrap())
            );
        }
        let resolved = host("a", "inventory", &entry);
        assert_eq!(resolved.id, identity);
        assert!(resolved.key_path.is_none());
        assert_eq!(resolved.auth_method, "password");
    }
    #[test]
    fn rejects_secrets_duplicate_ids_controls_and_unbounded_sources() {
        for (key, value) in [
            ("password", json!("secret")),
            ("keyPath", json!("/secret")),
            ("port", json!(0)),
            ("host", json!("host\nspoof")),
            ("name", json!("\u{202e}spoof")),
            ("username", json!("")),
        ] {
            let mut candidate = source();
            candidate["entries"][0][key] = value;
            assert!(Source::parse(candidate).is_err(), "{key}");
        }
        let mut candidate = source();
        candidate["entries"] = json!([
            candidate["entries"][0].clone(),
            candidate["entries"][0].clone()
        ]);
        assert!(Source::parse(candidate).is_err());
        let mut candidate = source();
        candidate["entries"] = json!((0..257)
            .map(|i| json!({"id":i.to_string(),"name":"Server","host":"host","username":"u"}))
            .collect::<Vec<_>>());
        assert!(Source::parse(candidate).is_err());
    }
    #[test]
    fn runtime_replacement_revocation_and_aggregate_limits_are_atomic() {
        let registry = Registry::with_limit_error("plugin.hostSources.limit");
        apply(
            &registry,
            lease("a", 1),
            "hosts.setSource",
            source(),
            |_| Ok(()),
        )
        .unwrap();
        apply(
            &registry,
            lease("b", 1),
            "hosts.setSource",
            source(),
            |_| Ok(()),
        )
        .unwrap();
        apply(
            &registry,
            lease("a", 2),
            "hosts.setSource",
            source(),
            |_| Ok(()),
        )
        .unwrap();
        registry.remove_runtime("a", |g| g < 2);
        assert_eq!(registry.snapshot(|_| true).1.len(), 2);
        assert_eq!(
            apply(
                &registry,
                lease("a", 1),
                "hosts.removeSource",
                json!({"id":"inventory"}),
                |_| Ok(())
            )
            .unwrap(),
            false
        );
        assert!(apply(
            &registry,
            lease("a", 2),
            "hosts.setSource",
            source(),
            |_| Err(AppError::validation("denied"))
        )
        .is_err());
        let big = |id: &str, size: usize| json!({"id":id,"label":"Inventory","entries":(0..size).map(|i| json!({"id":i.to_string(),"name":"Server","host":"host","username":"u"})).collect::<Vec<_>>()});
        apply(
            &registry,
            lease("a", 2),
            "hosts.setSource",
            big("inventory", 256),
            |_| Ok(()),
        )
        .unwrap();
        apply(
            &registry,
            lease("a", 2),
            "hosts.setSource",
            big("second", 256),
            |_| Ok(()),
        )
        .unwrap();
        assert!(apply(
            &registry,
            lease("a", 2),
            "hosts.setSource",
            source(),
            |_| Ok(())
        )
        .is_ok());
        assert!(apply(
            &registry,
            lease("a", 2),
            "hosts.setSource",
            big("third", 256),
            |_| Ok(())
        )
        .is_err());
        assert_eq!(registry.snapshot(|_| true).1.len(), 3);
        registry.remove_runtime("a", |_| true);
        assert_eq!(registry.snapshot(|_| true).1.len(), 1);
        assert!(registry.snapshot(|_| false).1.is_empty());
    }
}
