//! Explicit portable configuration. Credentials, runtime sessions and arbitrary
//! plugin storage never enter this format. Imports only create fresh identities.
mod apply;
pub(crate) mod files;
#[cfg(test)]
mod tests;
use crate::{
    db,
    error::{AppError, AppResult},
    models::{Host, HostInput},
    network::{ConnectionRoute, ProxyProfile},
    services::{forwarding, mounts},
};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};

pub(crate) const MAX_BYTES: usize = 4 * 1024 * 1024;
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct HostRecord {
    id: String,
    name: String,
    group_id: Option<String>,
    host: String,
    port: u16,
    username: String,
    auth_method: String,
    favorite: bool,
    color: Option<String>,
    tags: Vec<String>,
    note: Option<String>,
    route: ConnectionRoute,
}
impl HostRecord {
    fn input(&self, group_id: Option<String>) -> HostInput {
        HostInput {
            name: self.name.clone(),
            group_id,
            host: self.host.clone(),
            port: Some(self.port),
            username: Some(self.username.clone()),
            auth_method: Some(self.auth_method.clone()),
            key_path: None,
            favorite: self.favorite,
            color: self.color.clone(),
            tags: self.tags.clone(),
            note: self.note.clone(),
        }
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Folder {
    id: String,
    name: String,
    parent_id: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Forward {
    rule: forwarding::contract::ForwardRule,
    group_id: Option<String>,
    automation: forwarding::automation::Options,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ForwardGroup {
    id: String,
    host_id: String,
    name: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Document {
    format: String,
    version: u32,
    platform: String,
    roots: Vec<String>,
    hosts: Vec<HostRecord>,
    folders: Vec<Folder>,
    proxies: Vec<ProxyProfile>,
    forward_groups: Vec<ForwardGroup>,
    forwards: Vec<Forward>,
    mount_groups: Vec<mounts::contract::Group>,
    mount_rules: Vec<mounts::contract::Rule>,
}
fn invalid() -> AppError {
    AppError::validation("hostTransfer.invalid")
}
fn changed() -> AppError {
    AppError::validation("hostTransfer.changed")
}
fn id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
}
fn unique<'a>(ids: impl Iterator<Item = &'a str>) -> AppResult<HashSet<&'a str>> {
    let mut set = HashSet::new();
    for value in ids {
        if !id(value) || !set.insert(value) {
            return Err(invalid());
        }
    }
    Ok(set)
}
fn dependencies(document: &Document, ids: &[String]) -> AppResult<HashSet<String>> {
    let hosts: HashMap<_, _> = document.hosts.iter().map(|h| (h.id.as_str(), h)).collect();
    // A saved route is an explicit hop list: a hop's own route is not expanded
    // during SSH connection. Mutual references across independent routes are
    // valid, but migration still includes every referenced host's configuration.
    let mut selected = HashSet::new();
    let mut pending: Vec<_> = ids.iter().map(String::as_str).collect();
    while let Some(id) = pending.pop() {
        if selected.contains(id) {
            continue;
        }
        let host = hosts.get(id).ok_or_else(invalid)?;
        selected.insert(id.to_owned());
        pending.extend(host.route.jump_hosts.iter().map(String::as_str));
    }
    Ok(selected)
}
fn validate(document: &Document) -> AppResult<()> {
    if document.format != "tunnelde-hosts"
        || document.version != 1
        || document.hosts.is_empty()
        || document.hosts.len() > 500
        || document.roots.is_empty()
        || document.roots.len() > 500
        || document.folders.len() > 500
        || document.forwards.len() > 4096
        || document.forward_groups.len() > 512
        || document.mount_groups.len() > 512
        || document.mount_rules.len() > 2048
        || !matches!(document.platform.as_str(), "macos" | "windows" | "linux")
        || serde_json::to_vec(document)?.len() > MAX_BYTES
    {
        return Err(invalid());
    }
    let hosts = unique(document.hosts.iter().map(|h| h.id.as_str()))?;
    unique(document.roots.iter().map(String::as_str))?;
    let folders = unique(document.folders.iter().map(|g| g.id.as_str()))?;
    let groups = unique(document.forward_groups.iter().map(|g| g.id.as_str()))?;
    unique(document.forwards.iter().map(|r| r.rule.id.as_str()))?;
    unique(document.mount_groups.iter().map(|g| g.id.as_str()))?;
    unique(document.mount_rules.iter().map(|r| r.id.as_str()))?;
    let network = crate::network::NetworkSettings {
        profiles: document.proxies.clone(),
        ..Default::default()
    };
    network.validate()?;
    for host in &document.hosts {
        host.input(None).validate()?;
        if host
            .group_id
            .as_deref()
            .is_some_and(|id| !folders.contains(id))
            || host.route.jump_hosts.len() > 8
        {
            return Err(invalid());
        }
        if !["direct", "system"].contains(&host.route.proxy.as_str())
            && !network.profiles.iter().any(|p| p.id == host.route.proxy)
        {
            return Err(invalid());
        }
        if host.route.proxy.is_empty() {
            return Err(invalid());
        }
        if host.route.jump_hosts.contains(&host.id)
            || host.route.jump_hosts.iter().collect::<HashSet<_>>().len()
                != host.route.jump_hosts.len()
        {
            return Err(invalid());
        }
    }
    dependencies(
        document,
        &document
            .hosts
            .iter()
            .map(|h| h.id.clone())
            .collect::<Vec<_>>(),
    )?;
    for folder in &document.folders {
        crate::models::GroupInput {
            name: folder.name.clone(),
            parent_id: None,
        }
        .validate()?;
        let mut current = folder.parent_id.as_deref();
        let mut seen = HashSet::from([folder.id.as_str()]);
        while let Some(parent) = current {
            if !seen.insert(parent) {
                return Err(invalid());
            }
            current = document
                .folders
                .iter()
                .find(|g| g.id == parent)
                .ok_or_else(invalid)?
                .parent_id
                .as_deref();
        }
    }
    for group in &document.forward_groups {
        if !hosts.contains(group.host_id.as_str())
            || group.name.trim().is_empty()
            || group.name.chars().count() > 80
        {
            return Err(invalid());
        }
    }
    for forward in &document.forwards {
        forwarding::contract::validate(&forward.rule)?;
        if !hosts.contains(forward.rule.host_id.as_str())
            || forward.group_id.as_deref().is_some_and(|id| {
                !groups.contains(id)
                    || !document
                        .forward_groups
                        .iter()
                        .any(|g| g.id == id && g.host_id == forward.rule.host_id)
            })
        {
            return Err(invalid());
        }
    }
    for group in &document.mount_groups {
        mounts::contract::validate_group(group)?;
        if !hosts.contains(group.host_id.as_str()) {
            return Err(invalid());
        }
    }
    for rule in &document.mount_rules {
        // Validate syntax on its source platform. Local mount points are reviewed
        // and validated for this device at preview/apply, never silently rewritten.
        if !hosts.contains(rule.host_id.as_str())
            || !document
                .mount_groups
                .iter()
                .any(|g| g.id == rule.group_id && g.host_id == rule.host_id)
            || rule.name.trim().is_empty()
            || rule.name.len() > 120
            || rule.remote_path.len() > 2048
            || !rule.remote_path.starts_with('/')
            || rule.remote_path.split('/').any(|p| matches!(p, "." | ".."))
            || rule.mount_point.is_empty()
            || rule.mount_point.len() > 2048
            || rule
                .remote_path
                .chars()
                .chain(rule.mount_point.chars())
                .any(char::is_control)
        {
            return Err(invalid());
        }
    }
    Ok(())
}
pub(crate) fn export_at(conn: &Connection, ids: &[String]) -> AppResult<Document> {
    if ids.is_empty() || ids.len() > 500 {
        return Err(invalid());
    }
    unique(ids.iter().map(String::as_str))?;
    let settings = db::settings::load_checked(conn)?;
    let hosts = db::hosts::list_hosts(conn)?;
    let mut document = Document {
        format: "tunnelde-hosts".into(),
        version: 1,
        platform: std::env::consts::OS.into(),
        roots: ids.into(),
        hosts: Vec::new(),
        folders: Vec::new(),
        proxies: Vec::new(),
        forward_groups: Vec::new(),
        forwards: Vec::new(),
        mount_groups: Vec::new(),
        mount_rules: Vec::new(),
    };
    for host in hosts {
        let mut route = crate::network::route_at(conn, &host.id)?;
        route.proxy =
            crate::network::selection(&settings.network, "ssh", Some(&route.proxy)).into();
        document.hosts.push(HostRecord {
            id: host.id,
            name: host.name,
            group_id: host.group_id,
            host: host.host,
            port: host.port,
            username: host.username,
            auth_method: host.auth_method,
            favorite: host.favorite,
            color: host.color,
            tags: host.tags,
            note: host.note,
            route,
        });
    }
    let selected = dependencies(&document, ids)?;
    document.hosts.retain(|host| selected.contains(&host.id));
    let mut folder_ids: HashSet<String> = document
        .hosts
        .iter()
        .filter_map(|h| h.group_id.clone())
        .collect();
    let folders = db::hosts::list_groups(conn)?;
    loop {
        let prior = folder_ids.len();
        for g in &folders {
            if folder_ids.contains(&g.id) {
                if let Some(parent) = &g.parent_id {
                    folder_ids.insert(parent.clone());
                }
            }
        }
        if prior == folder_ids.len() {
            break;
        }
    }
    document.folders = folders
        .into_iter()
        .filter(|g| folder_ids.contains(&g.id))
        .map(|g| Folder {
            id: g.id,
            name: g.name,
            parent_id: g.parent_id,
        })
        .collect();
    document.proxies = settings
        .network
        .profiles
        .into_iter()
        .filter(|p| document.hosts.iter().any(|h| h.route.proxy == p.id))
        .collect();
    document.forward_groups = forwarding::groups::list(conn, None)?
        .into_iter()
        .filter(|g| selected.contains(&g.host_id))
        .map(|g| ForwardGroup {
            id: g.id,
            host_id: g.host_id,
            name: g.name,
        })
        .collect();
    for entry in forwarding::repository::list_conn(conn)? {
        if selected.contains(&entry.rule.host_id) {
            document.forwards.push(Forward {
                automation: forwarding::automation::settings::read(
                    conn,
                    &entry.rule.id,
                    &entry.revision,
                )?,
                rule: entry.rule,
                group_id: entry.group_id,
            });
        }
    }
    document.mount_groups = mounts::repository::all::<mounts::contract::Group>(conn, None)?
        .into_iter()
        .map(|g| g.value)
        .filter(|g| selected.contains(&g.host_id))
        .collect();
    document.mount_rules = mounts::repository::all::<mounts::contract::Rule>(conn, None)?
        .into_iter()
        .map(|r| r.value)
        .filter(|r| selected.contains(&r.host_id))
        .collect();
    validate(&document)?;
    Ok(document)
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Preview {
    pub revision: String,
    pub entries: Vec<PreviewEntry>,
    pub document: Document,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PreviewEntry {
    id: String,
    name: String,
    address: String,
    conflict: bool,
    dependency: bool,
    requires: Vec<String>,
    forwards: usize,
    mounts: usize,
}
fn revision(conn: &Connection) -> AppResult<String> {
    let mut hash = Sha256::new();
    for sql in ["SELECT id,name,coalesce(parent_id,'') FROM groups ORDER BY id", "SELECT id,name,host,port,username,auth_method,coalesce(group_id,''),updated_at FROM hosts ORDER BY id", "SELECT key,value FROM settings ORDER BY key", "SELECT revision FROM mount_state"] {
        let mut stmt=conn.prepare(sql)?;let count=stmt.column_count();let mut rows=stmt.query([])?;
        while let Some(row)=rows.next()? {for i in 0..count {let value:rusqlite::types::Value=row.get(i)?;let raw=format!("{value:?}");hash.update((raw.len() as u64).to_le_bytes());hash.update(raw);}}
    }
    Ok(format!("{:x}", hash.finalize()))
}
pub(crate) fn preview_at(conn: &Connection, document: Document) -> AppResult<Preview> {
    validate(&document)?;
    let existing = db::hosts::list_hosts(conn)?;
    let entries = document
        .hosts
        .iter()
        .map(|host| PreviewEntry {
            id: host.id.clone(),
            name: host.name.clone(),
            address: format!("{}@{}:{}", host.username, host.host, host.port),
            conflict: existing.iter().any(|h| {
                h.name.trim().to_lowercase() == host.name.trim().to_lowercase()
                    || (h
                        .host
                        .trim_end_matches('.')
                        .eq_ignore_ascii_case(host.host.trim().trim_end_matches('.'))
                        && h.port == host.port
                        && h.username == host.username.trim())
            }),
            dependency: !document.roots.contains(&host.id),
            requires: host.route.jump_hosts.clone(),
            forwards: document
                .forwards
                .iter()
                .filter(|r| r.rule.host_id == host.id)
                .count(),
            mounts: document
                .mount_rules
                .iter()
                .filter(|r| r.host_id == host.id)
                .count(),
        })
        .collect();
    Ok(Preview {
        revision: revision(conn)?,
        entries,
        document,
    })
}
pub(crate) use apply::{apply_at, ImportRequest};
