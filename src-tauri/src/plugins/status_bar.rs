//! Status bar v1 wire contract. Never expose application store/layout structs.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use super::{
    api::{self, HostContext},
    contributions::Owned,
    security::Lease,
};
use crate::{
    error::{AppError, AppResult},
    state::AppState,
};

pub const EVENT: &str = "plugin://status-bar-changed";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Alignment {
    Left,
    Right,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Icon {
    Activity,
    Check,
    Alert,
    Info,
    Sync,
    Terminal,
    Cloud,
    Code,
    Plug,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusBarItem {
    pub id: String,
    pub text: String,
    #[serde(default = "left")]
    pub alignment: Alignment,
    #[serde(default)]
    pub priority: i32,
    #[serde(default)]
    pub tooltip: Option<String>,
    #[serde(default)]
    pub icon: Option<Icon>,
    #[serde(default)]
    pub command: Option<String>,
}

fn left() -> Alignment {
    Alignment::Left
}

impl StatusBarItem {
    fn parse(params: Value) -> AppResult<Self> {
        let item: Self = serde_json::from_value(params)
            .map_err(|_| AppError::validation("plugin.statusBar.invalidItem"))?;
        if !valid_id(&item.id)
            || item
                .text
                .trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
                .is_empty()
            || !plain(&item.text, 128)
            || !(-1000..=1000).contains(&item.priority)
            || item
                .tooltip
                .as_ref()
                .is_some_and(|value| !plain(value, 1024))
            || item.command.as_ref().is_some_and(|value| !valid_id(value))
        {
            return Err(AppError::validation("plugin.statusBar.invalidItem"));
        }
        Ok(item)
    }
}

fn plain(value: &str, max: usize) -> bool {
    value.chars().count() <= max
        && !value.chars().any(|c| {
            c.is_control() || matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
        })
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Contribution {
    pub plugin_id: String,
    pub plugin_name: String,
    pub token: String,
    #[serde(flatten)]
    pub item: StatusBarItem,
}

#[derive(Clone, Serialize)]
pub struct Snapshot {
    pub revision: u64,
    pub items: Vec<Contribution>,
}

fn authorize(app: &AppHandle, lease: &Lease) -> AppResult<()> {
    app.state::<AppState>()
        .plugins
        .security
        .authorize(
            &lease.id,
            &lease.fingerprint,
            &lease.permissions,
            None,
            Some(lease.generation),
        )
        .map(|_| ())
}

fn entries(app: &AppHandle) -> (u64, Vec<Owned<StatusBarItem>>) {
    app.state::<AppState>()
        .plugins
        .status_bar
        .snapshot(|lease| authorize(app, lease).is_ok())
}

#[tauri::command]
pub fn plugin_status_bar_snapshot(app: AppHandle) -> Snapshot {
    let state = app.state::<AppState>();
    let (revision, items) = entries(&app);
    Snapshot {
        revision,
        items: items
            .into_iter()
            .map(|owned| Contribution {
                plugin_name: state.plugins.status_bar_name(&owned.lease.id),
                plugin_id: owned.lease.id,
                token: owned.token,
                item: owned.value,
            })
            .collect(),
    }
}

pub(super) fn emit(app: &AppHandle) {
    let _ = app.emit(EVENT, plugin_status_bar_snapshot(app.clone()));
}

pub(super) fn remove_runtime(app: &AppHandle, id: &str, generation: impl Fn(u64) -> bool) {
    app.state::<AppState>()
        .plugins
        .status_bar
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
    let result = apply(
        &state.plugins.status_bar,
        lease,
        method,
        params,
        |command| state.plugins.status_bar_command(&context.id, command),
        |lease| authorize(app, lease),
    )?;
    emit(app);
    Ok(result)
}

fn apply(
    registry: &super::contributions::Registry<StatusBarItem>,
    lease: Lease,
    method: &str,
    params: Value,
    command_exists: impl Fn(&str) -> bool,
    valid: impl Fn(&Lease) -> AppResult<()>,
) -> AppResult<Value> {
    match method {
        "statusBar.set" => {
            let item = StatusBarItem::parse(params)?;
            if item
                .command
                .as_ref()
                .is_some_and(|command| !command_exists(command))
            {
                return Err(AppError::validation("plugin.statusBar.unknownCommand"));
            }
            registry.upsert(lease, item.id.clone(), item, &valid)?;
            Ok(Value::Null)
        }
        "statusBar.remove" => {
            let id: String = api::field(&params, "id")?;
            if !valid_id(&id) {
                return Err(AppError::validation("plugin.statusBar.invalidItem"));
            }
            Ok(json!(registry.remove(&lease, &id, &valid)?))
        }
        _ => Err(AppError::validation("plugin.api.unknownMethod")),
    }
}

#[tauri::command]
pub async fn plugin_status_bar_execute(
    app: AppHandle,
    token: String,
    locale: Option<String>,
) -> AppResult<Value> {
    let (_, items) = entries(&app);
    let item = items
        .into_iter()
        .find(|item| item.token == token)
        .ok_or_else(|| AppError::validation("plugin.statusBar.expired"))?;
    let command = item
        .value
        .command
        .ok_or_else(|| AppError::validation("plugin.statusBar.unknownCommand"))?;
    if !app
        .state::<AppState>()
        .plugins
        .status_bar_command(&item.lease.id, &command)
    {
        return Err(AppError::validation("plugin.statusBar.unknownCommand"));
    }
    app.state::<AppState>()
        .plugins
        .run_bound(
            &item.lease.id,
            &command,
            Some(json!({"_locale":locale})),
            &item.lease,
        )
        .await
}

#[cfg(test)]
pub(super) fn contract_samples() -> Vec<Value> {
    let registry = super::contributions::Registry::default();
    let lease = Lease {
        id: "sample".into(),
        fingerprint: "digest".into(),
        permissions: vec![],
        generation: 1,
    };
    let mut samples = Vec::new();
    for (method, params, input_valid) in [
        (
            "statusBar.set",
            json!({"id":"build","text":"就绪 😀","future":1}),
            true,
        ),
        (
            "statusBar.set",
            json!({"id":"build","text":"x","alignment":"right","priority":-1000,"icon":"cloud","tooltip":null,"command":"open"}),
            true,
        ),
        ("statusBar.remove", json!({"id":"build"}), true),
        ("statusBar.remove", json!({"id":"build"}), true),
        (
            "statusBar.set",
            json!({"id":"unknown","text":"x","command":"missing"}),
            true,
        ),
        ("statusBar.set", json!({"id":"bad/id","text":"x"}), false),
        ("statusBar.set", json!({"id":"ok","text":"x\n"}), false),
        ("statusBar.set", json!({"id":"ok","text":" "}), false),
        (
            "statusBar.set",
            json!({"id":"ok","text":"x","priority":0.5}),
            false,
        ),
        (
            "statusBar.set",
            json!({"id":"ok","text":"x","icon":"raw-html"}),
            false,
        ),
        (
            "statusBar.set",
            json!({"id":"ok","text":"x".repeat(129)}),
            false,
        ),
        (
            "statusBar.set",
            json!({"id":"ok","text":"😀".repeat(128)}),
            true,
        ),
        ("statusBar.remove", json!({"id":"ok\n"}), false),
        ("statusBar.remove", json!({}), false),
        ("statusBar.remove", json!({"id":null}), false),
    ] {
        let result = apply(
            &registry,
            lease.clone(),
            method,
            params.clone(),
            |command| command == "open",
            |_| Ok(()),
        );
        samples.push(match result {
            Ok(result) => json!({"method":method,"params":params,"result":result,"inputValid":input_valid}),
            Err(error) => json!({"method":method,"params":params,"error":super::host::error_payload(&error),"inputValid":input_valid}),
        });
    }
    samples
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn wire_validation_and_defaults_are_independent_of_ui() {
        let item =
            StatusBarItem::parse(json!({"id":"build.status", "text":"中文 42", "future":true}))
                .unwrap();
        assert!(matches!(item.alignment, Alignment::Left));
        assert_eq!(item.priority, 0);
        for params in [
            json!({"id":"bad/id","text":"ok"}),
            json!({"id":"ok","text":" "}),
            json!({"id":"ok","text":"x\n"}),
            json!({"id":"ok","text":"\u{202e}exe"}),
            json!({"id":"ok","text":"x","icon":"html"}),
            json!({"id":"ok","text":"x","alignment":"top"}),
            json!({"id":"ok","text":"x","priority":1001}),
            json!({"id":"ok","text":"x","priority":0.5}),
            json!({"id":"ok","text":"x".repeat(129)}),
            json!({"id":"ok","text":"x","command":"plugin:other"}),
        ] {
            assert!(StatusBarItem::parse(params).is_err());
        }
    }
}
