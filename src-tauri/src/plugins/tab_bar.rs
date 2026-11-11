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

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClickContext {
    pub tab_id: String,
    pub tab_kind: String,
    pub pane_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CommandContext {
    item_id: String,
    #[serde(flatten)]
    view: ClickContext,
    value: Option<String>,
}

#[derive(Serialize)]
struct CommandInput {
    _locale: Option<String>,
    #[serde(rename = "_tabBar")]
    tab_bar: CommandContext,
}

fn command_request(
    item: &Owned<TabBarItem>,
    context: ClickContext,
    value: Option<String>,
    locale: Option<String>,
    command_exists: impl Fn(&str) -> bool,
) -> AppResult<(String, Value)> {
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
        .as_ref()
        .filter(|command| command_exists(command))
        .ok_or_else(|| AppError::validation("plugin.tabBar.unknownCommand"))?;
    let input = serde_json::to_value(CommandInput {
        _locale: locale,
        tab_bar: CommandContext {
            item_id: item.value.id.clone(),
            view: context,
            value,
        },
    })?;
    Ok((command.clone(), input))
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
    let (command, input) = command_request(&item, context, value, locale, |command| {
        app.state::<AppState>()
            .plugins
            .status_bar_command(&item.lease.id, command)
    })?;
    app.state::<AppState>()
        .plugins
        .run_bound(&item.lease.id, &command, Some(input), &item.lease)
        .await
        .map_err(|error| match error {
            AppError::Validation(ref message) if message == "plugin.statusBar.expired" => {
                AppError::validation("plugin.tabBar.expired")
            }
            other => other,
        })
}

#[cfg(test)]
pub(super) fn contract_samples() -> Vec<Value> {
    let registry = Registry::default();
    let lease = Lease {
        id: "sample".into(),
        fingerprint: "digest".into(),
        permissions: vec![],
        generation: 1,
    };
    let mut samples = Vec::new();
    let mut run = |method, params: Value, input_valid| {
        let result = apply(
            &registry,
            lease.clone(),
            method,
            params.clone(),
            |command| command == "go",
            |_| Ok(()),
        );
        let mut sample = match result {
            Ok(result) => {
                json!({"method":method,"params":params,"result":result,"inputValid":input_valid})
            }
            Err(error) => {
                json!({"method":method,"params":params,"error":super::host::error_payload(&error),"inputValid":input_valid})
            }
        };
        if method == "tabBar.set" && sample.get("result").is_some() {
            let item = registry
                .snapshot(|_| true)
                .1
                .into_iter()
                .find(|item| Some(item.value.id.as_str()) == params["id"].as_str())
                .unwrap();
            if item.value.command.is_some() && !item.value.disabled {
                let selected = matches!(item.value.kind, ControlKind::Select)
                    .then(|| item.value.value.clone().unwrap());
                let context = ClickContext {
                    tab_id: "plugin:sample:main".into(),
                    tab_kind: "plugin".into(),
                    pane_id: "pane-1".into(),
                };
                let (_, input) =
                    command_request(&item, context, selected, Some("zh-CN".into()), |_| true)
                        .unwrap();
                sample["commandInput"] = input;
            }
        }
        samples.push(sample);
    };
    for params in [
        json!({"id":"a","title":"就绪 😀","kind":"text","future":true}),
        json!({"id":"a","title":"运行","kind":"button","command":"go"}),
        json!({"id":"a","title":"Follow","kind":"button","command":"go","placement":"leading","group":"output.view","tooltip":"Follow latest output","showLabel":true,"checked":false,"when":{}}),
        json!({"id":"a","title":"Target","kind":"select","command":"go","options":[{"value":"本机","label":"本机"},{"value":"远端","label":"远端"}],"value":"本机"}),
        json!({"id":"a","title":"😀".repeat(128),"kind":"text","priority":-1000,"icon":null,"command":null,"when":null,"value":null,"group":null,"tooltip":null,"checked":null}),
        json!({"id":"a","title":"\u{feff}","kind":"text"}),
    ] {
        run("tabBar.set", params, true);
    }
    run("tabBar.remove", json!({"id":"a","future":true}), true);
    run("tabBar.remove", json!({"id":"a"}), true);
    // Cross-field and ownership constraints require live runtime validation.
    for params in [
        json!({"id":"a","title":"x","kind":"button","command":"missing"}),
        json!({"id":"a","title":"x","kind":"select","command":"go","options":[{"value":"one","label":"a"},{"value":"one","label":"b"}],"value":"one"}),
        json!({"id":"a","title":"x","kind":"select","command":"go","options":[{"value":"one","label":"a"}],"value":"two"}),
    ] {
        run("tabBar.set", params, true);
    }
    for params in [
        json!({}),
        json!({"id":"a","title":"x","kind":"raw"}),
        json!({"id":"bad/id","title":"x","kind":"text"}),
        json!({"id":"a\n","title":"x","kind":"text"}),
        json!({"id":"a","title":"\u{85}","kind":"text"}),
        json!({"id":"a","title":" ","kind":"text"}),
        json!({"id":"a","title":"x\n","kind":"text"}),
        json!({"id":"a","title":"x\u{202e}","kind":"text"}),
        json!({"id":"a","title":"😀".repeat(129),"kind":"text"}),
        json!({"id":"a","title":"x","kind":"text","priority":0.5}),
        json!({"id":"a","title":"x","kind":"text","priority":1001}),
        json!({"id":"a","title":"x","kind":"text","placement":null}),
        json!({"id":"a","title":"x","kind":"text","icon":"html"}),
        json!({"id":"a","title":"x","kind":"text","when":{"tabKind":"unknown"}}),
        json!({"id":"a","title":"x","kind":"text","tooltip":"x".repeat(513)}),
        json!({"id":"a","title":"x","kind":"text","command":"go"}),
        json!({"id":"a","title":"x","kind":"text","checked":false}),
        json!({"id":"a","title":"x","kind":"button","command":null}),
        json!({"id":"a","title":"x","kind":"button","command":"go","value":"x"}),
        json!({"id":"a","title":"x","kind":"select","command":"go","options":[],"value":"x"}),
        json!({"id":"a","title":"x","kind":"select","command":"go","options":[{"value":"x","label":"x"}],"value":"x","checked":true}),
        json!({"id":"a","title":"x","kind":"text","disabled":null}),
    ] {
        run("tabBar.set", params, false);
    }
    for params in [json!({}), json!({"id":null}), json!({"id":"a\n"})] {
        run("tabBar.remove", params, false);
    }
    for index in 0..9 {
        run(
            "tabBar.set",
            json!({"id":format!("quota-{index}"),"title":"x","kind":"text"}),
            true,
        );
    }
    samples
}

#[cfg(test)]
mod tests {
    use super::*;
    fn context(tab_id: &str, tab_kind: &str) -> ClickContext {
        ClickContext {
            tab_id: tab_id.into(),
            tab_kind: tab_kind.into(),
            pane_id: "pane-1".into(),
        }
    }

    #[test]
    fn command_contract_preserves_opaque_ids_nulls_and_scope_checks() {
        let mut item = Owned {
            lease: Lease {
                id: "sample".into(),
                fingerprint: "digest".into(),
                permissions: vec![],
                generation: 1,
            },
            token: "host-private-token".into(),
            value: TabBarItem::parse(
                json!({"id":"run","kind":"button","title":"Run","command":"go"}),
            )
            .unwrap(),
        };
        for (tab, kind) in [
            ("plugin:sample:main", "plugin"),
            ("sidebar:plugin:sample:chat", "sidebar"),
        ] {
            let (command, input) =
                command_request(&item, context(tab, kind), None, None, |_| true).unwrap();
            assert_eq!(command, "go");
            assert_eq!(
                input,
                json!({"_locale":null,"_tabBar":{"itemId":"run","tabId":tab,"tabKind":kind,"paneId":"pane-1","value":null}})
            );
        }
        for view in [
            context("plugin:sample-other:main", "plugin"),
            context("editor:local:/a.json", "editor"),
            context("sidebar:plugin:other:chat", "sidebar"),
        ] {
            assert_eq!(
                command_request(&item, view, None, None, |_| true)
                    .unwrap_err()
                    .to_string(),
                "plugin.tabBar.invalidContext"
            );
        }
        item.value.when = Some(When {
            tab_id: Some("editor:local:/a.json".into()),
            tab_kind: Some("editor".into()),
        });
        assert!(command_request(
            &item,
            context("editor:local:/a.json", "editor"),
            None,
            Some("en-US".into()),
            |_| true
        )
        .is_ok());
        assert!(command_request(
            &item,
            context("editor:local:/b.json", "editor"),
            None,
            None,
            |_| true
        )
        .is_err());
        item.value.when = Some(When::default());
        assert_eq!(
            command_request(&item, context("opaque", "future"), None, None, |_| false)
                .unwrap_err()
                .to_string(),
            "plugin.tabBar.unknownCommand"
        );
        item.value.disabled = true;
        assert!(command_request(&item, context("opaque", "future"), None, None, |_| true).is_err());
    }

    #[test]
    fn select_command_requires_a_current_option_and_never_changes_registration() {
        let item = Owned {
            lease: Lease {
                id: "sample".into(),
                fingerprint: "digest".into(),
                permissions: vec![],
                generation: 1,
            },
            token: "token".into(),
            value: TabBarItem::parse(json!({"id":"target","kind":"select","title":"Target","command":"go","when":{},"options":[{"value":"local","label":"Local"},{"value":"remote","label":"Remote"}],"value":"local"})).unwrap(),
        };
        for value in [None, Some("missing".into())] {
            assert!(
                command_request(&item, context("opaque", "future"), value, None, |_| true).is_err()
            );
        }
        let (_, input) = command_request(
            &item,
            context("opaque", "future"),
            Some("remote".into()),
            Some("zh-CN".into()),
            |_| true,
        )
        .unwrap();
        assert_eq!(input["_tabBar"]["value"], "remote");
        assert_eq!(item.value.value.as_deref(), Some("local"));
    }

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
