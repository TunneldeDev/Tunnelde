use super::{lease, HostContext};
use crate::{
    error::{AppError, AppResult},
    plugins::api::{field, optional},
    services::{
        mounts::{
            contract::{Entry, Group, Rule},
            operations::{self, Step},
            repository,
            runtime::Authority,
        },
        operations::{Budget, Errors},
    },
    state::AppState,
};
use serde_json::Value;
use std::{
    collections::{BTreeMap, HashSet},
    sync::LazyLock,
};
use tauri::Manager;

pub(super) fn owns(method: &str) -> bool {
    matches!(
        method,
        "groups.connect"
            | "groups.disconnect"
            | "groups.reconnect"
            | "groups.remove"
            | "rules.remove"
            | "runtime.start"
            | "runtime.startMany"
            | "runtime.startAuto"
            | "runtime.connectAndStartAuto"
            | "runtime.startAll"
            | "runtime.stop"
            | "runtime.stopMany"
            | "runtime.stopAll"
            | "runtime.restart"
            | "runtime.retry"
    )
}
pub(super) async fn call(context: &HostContext, method: &str, params: Value) -> AppResult<Value> {
    static WORKERS: LazyLock<Budget> = LazyLock::new(|| {
        Budget::new(
            4,
            Errors {
                domain: "mounts.plan",
                busy: "mounts.operations.busy",
                cancelled: "mounts.operations.cancelled",
                failed: "mounts.operations.failed",
            },
        )
    });
    let worker = context.clone();
    let name = method.to_owned();
    let steps = WORKERS
        .blocking(move |cancel| {
            let state = worker.app.state::<AppState>();
            state.plugins.security.with_authorized_attempt(
                &lease(&worker),
                &["mounts.write"],
                || cancel.check(),
                || {
                    state.db.try_with(|conn| {
                        cancel.check()?;
                        prepare(&state, conn, &name, &params)
                    })
                },
            )
        })
        .await?;
    Ok(serde_json::to_value(operations::submit(
        &context.app,
        method,
        steps,
        Authority(Some(lease(context))),
    )?)?)
}
fn missing() -> AppError {
    AppError::NotFound("mounts.rules.notFound".into())
}
fn prepare(
    state: &AppState,
    conn: &rusqlite::Connection,
    method: &str,
    params: &Value,
) -> AppResult<Vec<Step>> {
    let rule =
        |id: &str| -> AppResult<Entry<Rule>> { repository::get(conn, id)?.ok_or_else(missing) };
    let group =
        |id: &str| -> AppResult<Entry<Group>> { repository::get(conn, id)?.ok_or_else(missing) };
    let expected: Option<String> = optional(params, "expectedRevision")?;
    let check = |revision: &str| -> AppResult<()> {
        if expected.as_ref().is_some_and(|e| e != revision) {
            Err(repository::changed())
        } else {
            Ok(())
        }
    };
    match method {
        "groups.connect"
        | "groups.disconnect"
        | "groups.reconnect"
        | "groups.remove"
        | "runtime.startAuto"
        | "runtime.connectAndStartAuto" => {
            let id: String = field(
                params,
                if method.starts_with("runtime.") {
                    "groupId"
                } else {
                    "id"
                },
            )?;
            let group = group(&id)?;
            check(&group.revision)?;
            if method == "groups.connect" {
                return Ok(vec![Step::Connect(group)]);
            }
            if method == "groups.disconnect" {
                return Ok(vec![Step::Disconnect(group)]);
            }
            let rules: Vec<_> = repository::all::<Rule>(conn, Some(&group.value.host_id))?
                .into_iter()
                .filter(|r| r.value.group_id == id)
                .collect();
            if method == "groups.remove" {
                if expected.is_none()
                    || (!rules.is_empty() && optional::<bool>(params, "removeRules")? != Some(true))
                {
                    return Err(AppError::validation("mounts.rules.groupNotEmpty"));
                }
                let confirmed_rules = rules
                    .into_iter()
                    .map(|rule| (rule.value.id, rule.revision))
                    .collect();
                return Ok(vec![Step::RemoveGroup(group, confirmed_rules)]);
            }
            let mut steps = vec![];
            if method == "groups.reconnect" {
                let wanted: HashSet<_> = state
                    .mount_runtime
                    .rule_states()
                    .into_iter()
                    .filter(|r| r.group_id == id && (r.desired || r.phase == "running"))
                    .map(|r| r.rule_id)
                    .collect();
                steps.push(Step::Disconnect(group.clone()));
                steps.push(Step::Connect(group));
                steps.extend(
                    rules
                        .into_iter()
                        .filter(|r| wanted.contains(&r.value.id))
                        .map(Step::Start),
                );
            } else {
                steps.push(Step::Connect(group));
                steps.extend(
                    rules
                        .into_iter()
                        .filter(|r| r.value.auto_mount)
                        .map(Step::Start),
                );
            }
            Ok(steps)
        }
        "runtime.start" | "runtime.retry" | "runtime.restart" | "runtime.stop" | "rules.remove" => {
            let rule = rule(&field::<String>(params, "id")?)?;
            check(&rule.revision)?;
            if method == "rules.remove" {
                if expected.is_none() {
                    return Err(repository::changed());
                }
                return Ok(vec![Step::RemoveRule(rule)]);
            }
            if method == "runtime.stop" {
                return Ok(vec![Step::Stop {
                    rule,
                    runtime_id: optional(params, "runtimeId")?,
                }]);
            }
            let mut steps = Vec::new();
            if method == "runtime.restart" {
                steps.push(Step::Stop {
                    rule: rule.clone(),
                    runtime_id: optional(params, "runtimeId")?,
                });
            }
            let g = group(&rule.value.group_id)?;
            steps.push(Step::Connect(g));
            steps.push(Step::Start(rule));
            Ok(steps)
        }
        "runtime.startMany" | "runtime.stopMany" => {
            let ids: Vec<String> = field(params, "ids")?;
            if ids.len() > 128 || ids.iter().collect::<HashSet<_>>().len() != ids.len() {
                return Err(AppError::validation("mounts.rules.limit"));
            }
            let runtime_ids: BTreeMap<String, String> =
                optional(params, "runtimeIds")?.unwrap_or_default();
            let mut connected = HashSet::new();
            let mut steps = Vec::new();
            for id in ids {
                let r = rule(&id)?;
                if method == "runtime.startMany" {
                    if connected.insert(r.value.group_id.clone()) {
                        steps.push(Step::Connect(group(&r.value.group_id)?));
                    }
                    steps.push(Step::Start(r));
                } else {
                    steps.push(Step::Stop {
                        rule: r,
                        runtime_id: runtime_ids.get(&id).cloned(),
                    });
                }
            }
            Ok(steps)
        }
        "runtime.startAll" | "runtime.stopAll" => {
            let host: String = field(params, "hostId")?;
            crate::db::hosts::find_host(conn, &host)?;
            let mode: Option<String> = optional(params, "mode")?;
            if mode
                .as_deref()
                .is_some_and(|mode| !matches!(mode, "all" | "manual"))
            {
                return Err(AppError::validation("mounts.rules.invalid"));
            }
            let rules = repository::all::<Rule>(conn, Some(&host))?;
            let mut connected = HashSet::new();
            let mut steps = Vec::new();
            for rule in rules {
                if method == "runtime.startAll" {
                    if mode.as_deref() == Some("manual") && rule.value.auto_mount {
                        continue;
                    }
                    if connected.insert(rule.value.group_id.clone()) {
                        steps.push(Step::Connect(group(&rule.value.group_id)?));
                    }
                    steps.push(Step::Start(rule));
                } else {
                    steps.push(Step::Stop {
                        rule,
                        runtime_id: None,
                    });
                }
            }
            Ok(steps)
        }
        _ => Err(AppError::validation("plugin.api.unknownMethod")),
    }
}
