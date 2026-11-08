//! Declarative tab-bar controls. Runtime ownership follows the same lease rules
//! as status items; no plugin HTML, CSS or application layout structs cross IPC.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use super::{
    api::{self, HostContext},
    contributions::{Owned, Registry},
    security::Lease,
};
use crate::{
    error::{AppError, AppResult},
    state::AppState,
};

pub const EVENT: &str = "plugin://tab-bar-changed";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ControlKind {
    Button,
    Select,
    Text,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Placement {
    Leading,
    #[default]
    Trailing,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct When {
    pub tab_kind: Option<String>,
    pub tab_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct OptionItem {
    pub value: String,
    pub label: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TabBarItem {
    pub id: String,
    pub title: String,
    pub kind: ControlKind,
    #[serde(default)]
    pub priority: i32,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub disabled: bool,
    #[serde(default)]
    pub when: Option<When>,
    #[serde(default)]
    pub options: Vec<OptionItem>,
    #[serde(default)]
    pub value: Option<String>,
    #[serde(default)]
    pub placement: Placement,
    #[serde(default)]
    pub group: Option<String>,
    #[serde(default)]
    pub tooltip: Option<String>,
    #[serde(default)]
    pub show_label: bool,
    #[serde(default)]
    pub checked: Option<bool>,
}

fn plain(value: &str, max: usize) -> bool {
    !value.trim().is_empty()
        && value.chars().count() <= max
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
impl TabBarItem {
    fn parse(params: Value) -> AppResult<Self> {
        let item: Self = serde_json::from_value(params)
            .map_err(|_| AppError::validation("plugin.tabBar.invalidItem"))?;
        let valid_kind = |kind: &str| {
            [
                "welcome",
                "host",
                "terminal",
                "sftp",
                "editor",
                "history",
                "monitor",
                "plugin",
                "pluginDetail",
                "settings",
                "about",
                "updates",
                "knownHosts",
                "sidebar",
            ]
            .contains(&kind)
        };
        let valid = valid_id(&item.id)
            && plain(&item.title, 128)
            && item.group.as_ref().is_none_or(|group| valid_id(group))
            && item
                .tooltip
                .as_ref()
                .is_none_or(|tooltip| plain(tooltip, 512))
            && (item.checked.is_none() || matches!(item.kind, ControlKind::Button))
            && (-1000..=1000).contains(&item.priority)
            && item.icon.as_ref().is_none_or(|icon| {
                [
                    "activity", "check", "alert", "info", "sync", "terminal", "cloud", "code",
                    "plug", "copy", "clear", "folder", "file", "wrap", "follow", "play", "pause",
                    "filter",
                ]
                .contains(&icon.as_str())
            })
            && item
                .command
                .as_ref()
                .is_none_or(|command| valid_id(command))
            && item.when.as_ref().is_none_or(|when| {
                when.tab_kind.as_deref().is_none_or(valid_kind)
                    && when.tab_id.as_ref().is_none_or(|id| plain(id, 512))
            })
            && item.options.len() <= 32
            && item
                .options
                .iter()
                .all(|option| plain(&option.value, 128) && plain(&option.label, 128))
            && item
                .options
                .iter()
                .map(|option| &option.value)
                .collect::<std::collections::HashSet<_>>()
                .len()
                == item.options.len()
            && match item.kind {
                ControlKind::Select => {
                    item.command.is_some()
                        && !item.options.is_empty()
                        && item.value.as_ref().is_some_and(|value| {
                            item.options.iter().any(|option| &option.value == value)
                        })
                }
                ControlKind::Button => {
                    item.command.is_some() && item.options.is_empty() && item.value.is_none()
                }
                ControlKind::Text => {
                    item.command.is_none() && item.options.is_empty() && item.value.is_none()
                }
            };
        if !valid {
            return Err(AppError::validation("plugin.tabBar.invalidItem"));
        }
        Ok(item)
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Contribution {
    pub plugin_id: String,
    pub plugin_name: String,
    pub token: String,
    #[serde(flatten)]
    pub item: TabBarItem,
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
fn entries(app: &AppHandle) -> (u64, Vec<Owned<TabBarItem>>) {
    app.state::<AppState>()
        .plugins
        .tab_bar
        .snapshot(|lease| authorize(app, lease).is_ok())
}
#[tauri::command]
pub fn plugin_tab_bar_snapshot(app: AppHandle) -> Snapshot {
    let (revision, items) = entries(&app);
    Snapshot {
        revision,
        items: items
            .into_iter()
            .map(|owned| Contribution {
                plugin_name: app
                    .state::<AppState>()
                    .plugins
                    .status_bar_name(&owned.lease.id),
                plugin_id: owned.lease.id,
                token: owned.token,
                item: owned.value,
            })
            .collect(),
    }
}
pub(super) fn emit(app: &AppHandle) {
    let _ = app.emit(EVENT, plugin_tab_bar_snapshot(app.clone()));
}
pub(super) fn remove_runtime(app: &AppHandle, id: &str, generation: impl Fn(u64) -> bool) {
    app.state::<AppState>()
        .plugins
        .tab_bar
        .remove_runtime(id, generation);
    emit(app);
}
fn apply(
    registry: &Registry<TabBarItem>,
    lease: Lease,
    method: &str,
    params: Value,
    command_exists: impl Fn(&str) -> bool,
    valid: impl Fn(&Lease) -> AppResult<()>,
) -> AppResult<Value> {
    match method {
        "tabBar.set" => {
            let item = TabBarItem::parse(params)?;
            if item
                .command
                .as_ref()
                .is_some_and(|command| !command_exists(command))
            {
                return Err(AppError::validation("plugin.tabBar.unknownCommand"));
            }
            registry
                .upsert(lease, item.id.clone(), item, valid)
                .map_err(|error| match error {
                    AppError::Validation(ref message) if message == "plugin.statusBar.limit" => {
                        AppError::validation("plugin.tabBar.limit")
                    }
                    other => other,
                })?;
            Ok(Value::Null)
        }
        "tabBar.remove" => {
            let id: String = api::field(&params, "id")?;
            if !valid_id(&id) {
                return Err(AppError::validation("plugin.tabBar.invalidItem"));
            }
            Ok(json!(registry.remove(&lease, &id, valid)?))
        }
        _ => Err(AppError::validation("plugin.api.unknownMethod")),
    }
}
pub(super) fn call(context: &HostContext, method: &str, params: Value) -> AppResult<Value> {
    let state = context.app.state::<AppState>();
    let lease = Lease {
        id: context.id.clone(),
        fingerprint: context.fingerprint.clone(),
        permissions: context.permissions.clone(),
        generation: context.generation,
    };
    let result = apply(
        &state.plugins.tab_bar,
        lease,
        method,
        params,
        |command| state.plugins.status_bar_command(&context.id, command),
        |lease| authorize(&context.app, lease),
    )?;
    emit(&context.app);
    Ok(result)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClickContext {
    pub tab_id: String,
    pub tab_kind: String,
    pub pane_id: String,
}

#[tauri::command]
pub async fn plugin_tab_bar_execute(
    app: AppHandle,
    token: String,
    context: ClickContext,
    value: Option<String>,
    locale: Option<String>,
) -> AppResult<Value> {
    let item = entries(&app)
        .1
        .into_iter()
        .find(|item| item.token == token)
        .ok_or_else(|| AppError::validation("plugin.tabBar.expired"))?;
    if item.value.disabled
        || !plain(&context.tab_id, 512)
        || !plain(&context.pane_id, 128)
        || !plain(&context.tab_kind, 32)
        || item.value.when.as_ref().is_some_and(|when| {
            when.tab_id.as_ref().is_some_and(|id| id != &context.tab_id)
                || when
                    .tab_kind
                    .as_ref()
                    .is_some_and(|kind| kind != &context.tab_kind)
        })
        || (item.value.when.is_none()
            && !((context.tab_kind == "plugin"
                && context
                    .tab_id
                    .starts_with(&format!("plugin:{}:", item.lease.id)))
                || (context.tab_kind == "sidebar"
                    && context
                        .tab_id
                        .starts_with(&format!("sidebar:plugin:{}:", item.lease.id)))))
        || (matches!(item.value.kind, ControlKind::Select)
            && value
                .as_ref()
                .is_none_or(|v| !item.value.options.iter().any(|option| &option.value == v)))
        || (!matches!(item.value.kind, ControlKind::Select) && value.is_some())
    {
        return Err(AppError::validation("plugin.tabBar.invalidContext"));
    }
    let command = item
        .value
        .command
        .ok_or_else(|| AppError::validation("plugin.tabBar.unknownCommand"))?;
    if !app
        .state::<AppState>()
        .plugins
        .status_bar_command(&item.lease.id, &command)
    {
        return Err(AppError::validation("plugin.tabBar.unknownCommand"));
    }
    app.state::<AppState>()
        .plugins
        .run_bound(
            &item.lease.id,
            &command,
            Some(json!({"_locale":locale,"_tabBar":{"itemId":item.value.id,"tabId":context.tab_id,"tabKind":context.tab_kind,"paneId":context.pane_id,"value":value}})),
            Some(item.lease.generation),
        )
        .await
        .map_err(|error| match error {
            AppError::Validation(ref message) if message == "plugin.statusBar.expired" => {
                AppError::validation("plugin.tabBar.expired")
            }
            other => other,
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_declarative_controls_and_rejects_unowned_commands() {
        for params in [
            json!({"id":"a","kind":"button","title":"Run","command":"go"}),
            json!({"id":"a","kind":"text","title":"Ready"}),
            json!({"id":"a","kind":"select","title":"Target","command":"go","options":[{"value":"local","label":"Local"}],"value":"local"}),
            json!({"id":"a","kind":"button","title":"Follow","command":"go","placement":"leading","group":"output.view","tooltip":"Follow latest output","showLabel":true,"checked":false}),
        ] {
            assert!(TabBarItem::parse(params).is_ok());
        }
        for params in [
            json!({"id":"a","kind":"html","title":"x"}),
            json!({"id":"a","kind":"button","title":"x"}),
            json!({"id":"a","kind":"text","title":"x","command":"go"}),
            json!({"id":"a","kind":"text","title":"x\n"}),
            json!({"id":"a","kind":"text","title":"x","when":{"tabKind":"raw"}}),
            json!({"id":"a","kind":"text","title":"x","icon":"html"}),
            json!({"id":"a","kind":"select","title":"x","command":"go","options":[{"value":"a","label":"a"}],"value":"b"}),
            json!({"id":"a","kind":"button","title":"x","command":"go","placement":"floating"}),
            json!({"id":"a","kind":"button","title":"x","command":"go","group":"bad/group"}),
            json!({"id":"a","kind":"button","title":"x","command":"go","tooltip":"bad\nline"}),
            json!({"id":"a","kind":"text","title":"x","checked":false}),
            json!({"id":"a","kind":"select","title":"x","command":"go","options":[{"value":"a","label":"a"}],"value":"a","checked":true}),
        ] {
            assert!(TabBarItem::parse(params).is_err());
        }
        let registry = Registry::default();
        let lease = Lease {
            id: "sample".into(),
            fingerprint: "digest".into(),
            permissions: vec![],
            generation: 1,
        };
        assert!(apply(
            &registry,
            lease.clone(),
            "tabBar.set",
            json!({"id":"a","kind":"button","title":"x","command":"other"}),
            |_| false,
            |_| Ok(())
        )
        .is_err());
        assert!(registry.snapshot(|_| true).1.is_empty());
        apply(
            &registry,
            lease.clone(),
            "tabBar.set",
            json!({"id":"a","kind":"text","title":"ready"}),
            |_| true,
            |_| Ok(()),
        )
        .unwrap();
        assert_eq!(
            apply(
                &registry,
                lease,
                "tabBar.remove",
                json!({"id":"a"}),
                |_| true,
                |_| Ok(())
            )
            .unwrap(),
            json!(true)
        );
    }

    #[test]
    fn old_controls_keep_default_layout_and_new_metadata_round_trips() {
        let old = TabBarItem::parse(json!({"id":"a","kind":"button","title":"Run","command":"go"}))
            .unwrap();
        let old = serde_json::to_value(old).unwrap();
        assert_eq!(old["placement"], "trailing");
        assert_eq!(old["showLabel"], false);
        assert!(old["checked"].is_null());
        let params = json!({"id":"a","kind":"button","title":"Follow","command":"go","placement":"leading","group":"navigation","tooltip":"Keep newest line visible","showLabel":true,"checked":true});
        let actual = serde_json::to_value(TabBarItem::parse(params.clone()).unwrap()).unwrap();
        for (key, expected) in params.as_object().unwrap() {
            assert_eq!(&actual[key], expected);
        }
        assert!(TabBarItem::parse(
            json!({"id":"a","kind":"text","title":"Ready","tooltip":"x".repeat(513)})
        )
        .is_err());
    }
}
