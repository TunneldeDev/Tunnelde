//! Ephemeral file-list highlights. Plugins submit semantic rules; the host owns matching and rendering.
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

pub const EVENT: &str = "plugin://file-highlights-changed";
const INVALID: &str = "plugin.fileList.invalidHighlight";

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
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Match {
    pub name: Option<String>,
    pub extension: Option<String>,
    pub path_prefix: Option<String>,
}

impl Match {
    fn is_empty(&self) -> bool {
        self.name.is_none() && self.extension.is_none() && self.path_prefix.is_none()
    }

    fn count(&self) -> usize {
        [&self.name, &self.extension, &self.path_prefix]
            .into_iter()
            .flatten()
            .count()
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Highlight {
    #[serde(rename = "match")]
    pub match_: Match,
    pub tooltip: Option<String>,
    #[serde(default)]
    pub tone: Tone,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HighlightSet {
    pub id: String,
    #[serde(default)]
    pub priority: i32,
    /// "local", a remote session ID, or `remote:<sessionId>`. Empty means all sources.
    #[serde(default)]
    pub source: String,
    /// Optional directory scope; the host applies it only to matching listing paths.
    #[serde(default)]
    pub directory: Option<String>,
    pub highlights: Vec<Highlight>,
}

fn source_key(source: &str) -> &str {
    source.strip_prefix("remote:").unwrap_or(source)
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

fn valid_directory(value: &str) -> bool {
    value.chars().count() <= 32768
        && !value.chars().any(|c| {
            c.is_control()
                || c == '\u{feff}'
                || matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
        })
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
}

fn valid_match_name(name: &str) -> bool {
    !name.is_empty()
        && name.chars().count() <= 512
        && !name.chars().any(|c| {
            c.is_control() || matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
        })
}

fn valid_source(source: &str) -> bool {
    source.is_empty()
        || source == "local"
        || (source.len() <= 128
            && source
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c)))
}

impl HighlightSet {
    fn parse(params: Value) -> AppResult<Self> {
        let mut set: Self =
            serde_json::from_value(params).map_err(|_| AppError::validation(INVALID))?;
        if !valid_id(&set.id) {
            return Err(AppError::validation(INVALID));
        }
        if set.highlights.is_empty() {
            return Ok(set);
        }
        set.source = source_key(&set.source).to_owned();
        let source = set.source.as_str();
        if !valid_id(&set.id)
            || !valid_source(source)
            || !(-1000..=1000).contains(&set.priority)
            || set.directory.as_ref().is_some_and(|v| !valid_directory(v))
            || set.highlights.len() > 256
            || serde_json::to_vec(&set)?.len() > 256 * 1024
        {
            return Err(AppError::validation(INVALID));
        }
        for item in &set.highlights {
            if item.match_.is_empty()
                || item.match_.count() > 1
                || item
                    .match_
                    .name
                    .as_ref()
                    .is_some_and(|v| !valid_match_name(v))
                || item.match_.extension.as_ref().is_some_and(|v| {
                    v.is_empty()
                        || v.len() > 64
                        || !v.is_ascii()
                        || v.starts_with('.')
                        || v.contains(['/', '\\', '\0'])
                })
                || item
                    .match_
                    .path_prefix
                    .as_ref()
                    .is_some_and(|v| !plain(v, 32768))
                || item.tooltip.as_ref().is_some_and(|v| !plain(v, 512))
            {
                return Err(AppError::validation(INVALID));
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
    pub set: HighlightSet,
}

#[derive(Clone, Serialize)]
pub struct Snapshot {
    pub revision: u64,
    pub items: Vec<Contribution>,
}

fn authorize(app: &AppHandle, lease: &Lease) -> AppResult<()> {
    let state = app.state::<AppState>();
    for permission in ["fileBrowser.read", "workspace.write"] {
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
pub fn plugin_file_highlights_snapshot(app: AppHandle) -> Snapshot {
    let state = app.state::<AppState>();
    let (revision, items) = state
        .plugins
        .file_highlights
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
    let _ = app.emit(EVENT, plugin_file_highlights_snapshot(app.clone()));
}

pub(super) fn remove_runtime(app: &AppHandle, id: &str, generation: impl Fn(u64) -> bool) {
    app.state::<AppState>()
        .plugins
        .file_highlights
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
    let origin = crate::platform::panel_windows::plugin_views::origin::current();
    let mutate = || {
        apply(
            &state.plugins.file_highlights,
            lease,
            method,
            params,
            |lease| authorize(app, lease),
        )
    };
    let result = match &origin {
        Some(origin) => origin.with_current(mutate)?,
        None => mutate()?,
    };
    emit(app);
    Ok(result)
}

fn apply(
    registry: &Registry<HighlightSet>,
    lease: Lease,
    method: &str,
    params: Value,
    valid: impl Fn(&Lease) -> AppResult<()>,
) -> AppResult<Value> {
    match method {
        "fileList.setHighlights" => {
            let set = HighlightSet::parse(params)?;
            if set.highlights.is_empty() {
                registry.remove(&lease, &set.id, valid)?;
            } else {
                registry.upsert(lease, set.id.clone(), set, valid)?;
            }
            Ok(Value::Null)
        }
        "fileList.removeHighlights" => {
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
            permissions: vec!["fileBrowser.read".into(), "workspace.write".into()],
            generation,
        }
    }

    fn params() -> Value {
        json!({
            "id":"generated",
            "priority":10,
            "source":"local",
            "highlights":[{"match":{"extension":"ts"},"tooltip":"Generated source","tone":"info"}]
        })
    }

    #[test]
    fn validates_bounded_semantic_rules_atomically() {
        assert!(HighlightSet::parse(params()).is_ok());
        let mut remote = params();
        remote["source"] = json!("remote:one");
        assert!(HighlightSet::parse(remote).is_ok());
        for (field, value) in [
            ("id", json!("bad id")),
            ("source", json!("remote:bad id")),
            ("priority", json!(1001)),
        ] {
            let mut bad = params();
            bad[field] = value;
            assert!(HighlightSet::parse(bad).is_err(), "accepted {field}");
        }
        for (field, value) in [
            ("name", json!("x".repeat(513))),
            ("name", json!("bad\nname")),
            ("extension", json!(".ts")),
            ("extension", json!("ts/x")),
            ("path_prefix", json!("bad\npath")),
            ("tooltip", json!("bad\u{202e}text")),
        ] {
            let mut bad = params();
            bad["highlights"][0]["match"][field] = value;
            assert!(HighlightSet::parse(bad).is_err(), "accepted {field}");
        }
        let mut bad = params();
        bad["directory"] = json!("bad\u{feff}path");
        assert!(HighlightSet::parse(bad).is_err());
        let mut bad = params();
        bad["source"] = json!("remote:bad id");
        assert!(HighlightSet::parse(bad).is_err());
        let mut bad = params();
        bad["highlights"][0]["match"]["name"] = json!("file.ts");
        assert!(HighlightSet::parse(bad).is_err());
        let mut bad = params();
        bad["highlights"][0]["match"] = json!({});
        assert!(HighlightSet::parse(bad).is_err());
        let mut bad = params();
        bad["highlights"] = json!((0..257)
            .map(|i| json!({"match":{"name":format!("{i}.ts")}}))
            .collect::<Vec<_>>());
        assert!(HighlightSet::parse(bad).is_err());
    }

    #[test]
    fn replacement_removal_and_runtime_boundaries_are_owner_scoped() {
        let registry = Registry::with_limit_error("plugin.fileList.limit");
        apply(
            &registry,
            lease("a", 1),
            "fileList.setHighlights",
            params(),
            |_| Ok(()),
        )
        .unwrap();
        apply(
            &registry,
            lease("b", 1),
            "fileList.setHighlights",
            params(),
            |_| Ok(()),
        )
        .unwrap();
        apply(
            &registry,
            lease("a", 2),
            "fileList.setHighlights",
            params(),
            |_| Ok(()),
        )
        .unwrap();
        registry.remove_runtime("a", |generation| generation < 2);
        assert_eq!(registry.snapshot(|_| true).1.len(), 2);
        assert_eq!(
            apply(
                &registry,
                lease("a", 1),
                "fileList.removeHighlights",
                json!({"id":"generated"}),
                |_| Ok(())
            )
            .unwrap(),
            json!(false)
        );
        let denied = |_: &Lease| Err(AppError::validation("revoked"));
        assert!(apply(
            &registry,
            lease("a", 2),
            "fileList.setHighlights",
            params(),
            denied
        )
        .is_err());
        assert_eq!(registry.snapshot(|_| true).1.len(), 2);
        apply(
            &registry,
            lease("a", 2),
            "fileList.setHighlights",
            json!({"id":"generated","highlights":[]}),
            |_| Ok(()),
        )
        .unwrap();
        assert_eq!(registry.snapshot(|_| true).1.len(), 1);
    }
}
