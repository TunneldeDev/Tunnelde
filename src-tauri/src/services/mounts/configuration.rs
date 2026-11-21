//! Validated persistence, paging and import plans. All writes are atomic.
use super::{
    contract::{Group, Rule, Save},
    repository::{self, Record},
};
use crate::error::{AppError, AppResult};
use rusqlite::Connection;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};

fn invalid() -> AppError {
    AppError::validation("mounts.rules.invalid")
}
fn encode(value: impl serde::Serialize) -> AppResult<Value> {
    Ok(serde_json::to_value(value)?)
}
fn parse<T: serde::de::DeserializeOwned>(value: Value) -> AppResult<T> {
    serde_json::from_value(value).map_err(|_| invalid())
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Id {
    id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Host {
    host_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Page {
    host_id: Option<String>,
    cursor: Option<String>,
    revision: Option<String>,
    limit: Option<usize>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RuleSave {
    rule: Rule,
    expected_revision: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GroupSave {
    group: Group,
    expected_revision: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Move {
    id: String,
    expected_revision: String,
    group_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CopyHost {
    source_host_id: String,
    target_host_id: String,
    expected_revision: String,
}

pub(crate) fn writes(method: &str) -> bool {
    matches!(
        method,
        "rules.save"
            | "rules.move"
            | "groups.save"
            | "rules.copyHost"
            | "rules.importApply"
            | "legacy.dismiss"
    )
}

pub(crate) fn call(
    runtime: &super::runtime::Coordinator,
    conn: &Connection,
    method: &str,
    params: Value,
) -> AppResult<Value> {
    match method {
        "rules.snapshot" => {
            let request: Host = parse(params)?;
            crate::db::hosts::find_host(conn, &request.host_id)?;
            let groups = repository::all::<Group>(conn, Some(&request.host_id))?;
            let rules = repository::all::<Rule>(conn, Some(&request.host_id))?;
            let ids: HashSet<_> = rules.iter().map(|r| r.value.id.as_str()).collect();
            let group_ids: HashSet<_> = groups.iter().map(|g| g.value.id.as_str()).collect();
            Ok(
                json!({"revision":repository::revision(conn)?,"runtimeRevision":runtime.revision(),"hostId":request.host_id,"ruleStates":runtime.rule_states().into_iter().filter(|s|ids.contains(s.rule_id.as_str())).collect::<Vec<_>>(),"connections":runtime.connection_states().into_iter().filter(|s|group_ids.contains(s.group_id.as_str())).collect::<Vec<_>>(),"rules":rules,"groups":groups}),
            )
        }
        "rules.list" | "groups.list" => {
            let p: Page = parse(params)?;
            if method == "rules.list" {
                encode(repository::page::<Rule>(
                    conn,
                    p.host_id.as_deref(),
                    p.cursor.as_deref(),
                    p.revision.as_deref(),
                    p.limit.unwrap_or(32),
                )?)
            } else {
                encode(repository::page::<Group>(
                    conn,
                    p.host_id.as_deref(),
                    p.cursor.as_deref(),
                    p.revision.as_deref(),
                    p.limit.unwrap_or(32),
                )?)
            }
        }
        "rules.get" => encode(repository::get::<Rule>(conn, &parse::<Id>(params)?.id)?),
        "groups.get" => encode(repository::get::<Group>(conn, &parse::<Id>(params)?.id)?),
        "rules.validate" => {
            let request: RuleSave = parse(params)?;
            request.rule.validate()?;
            crate::db::hosts::find_host(conn, &request.rule.host_id)?;
            let group =
                repository::get::<Group>(conn, &request.rule.group_id)?.ok_or_else(invalid)?;
            if group.value.host_id != request.rule.host_id {
                return Err(invalid());
            }
            Ok(json!({"valid":true}))
        }
        "groups.validate" => {
            let request: GroupSave = parse(params)?;
            request.group.validate()?;
            crate::db::hosts::find_host(conn, &request.group.host_id)?;
            Ok(json!({"valid":true}))
        }
        "rules.save" => {
            let request: RuleSave = parse(params)?;
            let prior = repository::get::<Rule>(conn, &request.rule.id)?;
            let mut ids = vec![request.rule.group_id.as_str()];
            if let Some(prior) = &prior {
                ids.push(&prior.value.group_id);
            }
            ids.sort_unstable();
            ids.dedup();
            let _gates = ids
                .into_iter()
                .map(|id| runtime.gate(id))
                .collect::<AppResult<Vec<_>>>()?;
            runtime.inactive(&request.rule.id)?;
            encode(repository::save(
                conn,
                Save {
                    value: request.rule,
                    expected_revision: request.expected_revision,
                },
            )?)
        }
        "groups.save" => {
            let request: GroupSave = parse(params)?;
            let _gate = runtime.gate(&request.group.id)?;
            runtime.group_inactive(&request.group.id)?;
            encode(repository::save(
                conn,
                Save {
                    value: request.group,
                    expected_revision: request.expected_revision,
                },
            )?)
        }
        "rules.move" => {
            let request: Move = parse(params)?;
            let mut rule =
                repository::get::<Rule>(conn, &request.id)?.ok_or_else(repository::changed)?;
            let mut ids = vec![rule.value.group_id.as_str(), request.group_id.as_str()];
            ids.sort_unstable();
            ids.dedup();
            let _gates = ids
                .into_iter()
                .map(|id| runtime.gate(id))
                .collect::<AppResult<Vec<_>>>()?;
            runtime.inactive(&request.id)?;
            rule.value.group_id = request.group_id;
            encode(repository::save(
                conn,
                Save {
                    value: rule.value,
                    expected_revision: Some(request.expected_revision),
                },
            )?)
        }
        "rules.copyHost" => {
            let request: CopyHost = parse(params)?;
            repository::check_revision(conn, Some(&request.expected_revision))?;
            if request.source_host_id == request.target_host_id {
                return Err(invalid());
            }
            crate::db::hosts::find_host(conn, &request.target_host_id)?;
            let groups = repository::all::<Group>(conn, Some(&request.source_host_id))?;
            let rules = repository::all::<Rule>(conn, Some(&request.source_host_id))?;
            let mut map = HashMap::new();
            let mut copied_groups = Vec::new();
            let mut copied_rules = Vec::new();
            for group in groups {
                let id = uuid::Uuid::new_v4().to_string();
                map.insert(group.value.id, id.clone());
                copied_groups.push(repository::save(
                    conn,
                    Save {
                        value: Group {
                            id,
                            host_id: request.target_host_id.clone(),
                            ..group.value
                        },
                        expected_revision: None,
                    },
                )?);
            }
            for rule in rules {
                copied_rules.push(repository::save(
                    conn,
                    Save {
                        value: Rule {
                            id: uuid::Uuid::new_v4().to_string(),
                            host_id: request.target_host_id.clone(),
                            group_id: map.get(&rule.value.group_id).ok_or_else(invalid)?.clone(),
                            auto_mount: false,
                            ..rule.value
                        },
                        expected_revision: None,
                    },
                )?);
            }
            Ok(
                json!({"revision":repository::revision(conn)?,"groups":copied_groups,"rules":copied_rules}),
            )
        }
        "rules.export" => export(conn, params),
        "rules.importPreview" | "rules.importApply" => import(runtime, conn, method, params),
        _ => Err(AppError::validation("plugin.api.unknownMethod")),
    }
}

#[derive(Clone, serde::Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Document {
    version: u32,
    host_id: String,
    groups: Vec<Group>,
    rules: Vec<Rule>,
}
fn export(conn: &Connection, params: Value) -> AppResult<Value> {
    let p: Page = parse(params)?;
    let host = p.host_id.ok_or_else(invalid)?;
    let page = repository::page::<Rule>(
        conn,
        Some(&host),
        p.cursor.as_deref(),
        p.revision.as_deref(),
        p.limit.unwrap_or(32),
    )?;
    let groups = repository::all::<Group>(conn, Some(&host))?
        .into_iter()
        .map(|g| g.value)
        .collect();
    Ok(
        json!({"revision":page.revision,"nextCursor":page.next_cursor,"document":Document {version:1,host_id:host,groups,rules:page.items.into_iter().map(|r|r.value).collect()}}),
    )
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Import {
    document: Document,
    expected_revision: Option<String>,
    digest: Option<String>,
    #[serde(default = "reject")]
    mode: String,
}
fn reject() -> String {
    "reject".into()
}
fn import(
    runtime: &super::runtime::Coordinator,
    conn: &Connection,
    method: &str,
    params: Value,
) -> AppResult<Value> {
    let request: Import = parse(params)?;
    if request.document.version != 1
        || request.document.groups.len() > 32
        || request.document.rules.len() > 32
        || !matches!(request.mode.as_str(), "reject" | "replace" | "skip")
    {
        return Err(invalid());
    }
    crate::db::hosts::find_host(conn, &request.document.host_id)?;
    let current = repository::check_revision(conn, request.expected_revision.as_deref())?;
    let digest = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&request.document)?)
    );
    if method == "rules.importApply"
        && (request.expected_revision.is_none() || request.digest.as_deref() != Some(&digest))
    {
        return Err(repository::changed());
    }
    let mut ids = HashSet::new();
    let mut group_ids = HashSet::new();
    let mut conflicts = Vec::new();
    for group in &request.document.groups {
        group.validate()?;
        if group.host_id != request.document.host_id || !ids.insert(("group", group.id.as_str())) {
            return Err(invalid());
        }
        group_ids.insert(group.id.as_str());
        if let Some(existing) = repository::get::<Group>(conn, &group.id)? {
            if existing.value.host_id != group.host_id {
                return Err(invalid());
            }
            conflicts.push(json!({"kind":"group","id":group.id,"revision":existing.revision}));
        }
    }
    for rule in &request.document.rules {
        rule.validate()?;
        if rule.host_id != request.document.host_id || !ids.insert(("rule", rule.id.as_str())) {
            return Err(invalid());
        }
        if !group_ids.contains(rule.group_id.as_str())
            && repository::get::<Group>(conn, &rule.group_id)?
                .is_none_or(|g| g.value.host_id != rule.host_id)
        {
            return Err(invalid());
        }
        if let Some(existing) = repository::get::<Rule>(conn, &rule.id)? {
            if existing.value.host_id != rule.host_id {
                return Err(invalid());
            }
            conflicts.push(json!({"kind":"rule","id":rule.id,"revision":existing.revision}));
        }
    }
    if method == "rules.importPreview" {
        return Ok(
            json!({"revision":current,"digest":digest,"conflicts":conflicts,"groups":request.document.groups.len(),"rules":request.document.rules.len()}),
        );
    }
    if request.mode == "reject" && !conflicts.is_empty() {
        return Err(repository::changed());
    }
    let mut gate_ids: Vec<_> = request
        .document
        .groups
        .iter()
        .map(|g| g.id.clone())
        .chain(request.document.rules.iter().map(|r| r.group_id.clone()))
        .collect();
    for rule in &request.document.rules {
        if let Some(old) = repository::get::<Rule>(conn, &rule.id)? {
            gate_ids.push(old.value.group_id);
        }
    }
    gate_ids.sort_unstable();
    gate_ids.dedup();
    let _gates = gate_ids
        .iter()
        .map(|id| runtime.gate(id))
        .collect::<AppResult<Vec<_>>>()?;
    let mut saved_groups = Vec::new();
    let mut saved_rules = Vec::new();
    for group in request.document.groups {
        let existing = repository::get::<Group>(conn, &group.id)?;
        if existing.is_some() && request.mode == "skip" {
            continue;
        }
        runtime.group_inactive(&group.id)?;
        saved_groups.push(repository::save(
            conn,
            Save {
                value: group,
                expected_revision: existing.map(|e| e.revision),
            },
        )?);
    }
    for rule in request.document.rules {
        let existing = repository::get::<Rule>(conn, &rule.id)?;
        if existing.is_some() && request.mode == "skip" {
            continue;
        }
        runtime.inactive(&rule.id)?;
        saved_rules.push(repository::save(
            conn,
            Save {
                value: rule,
                expected_revision: existing.map(|e| e.revision),
            },
        )?);
    }
    Ok(json!({"revision":repository::revision(conn)?,"groups":saved_groups,"rules":saved_rules}))
}
