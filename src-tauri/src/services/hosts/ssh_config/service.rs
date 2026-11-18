//! Preview against current storage, then import the selected source revision atomically.
use super::{
    contract::{Entry, ImportResult, Issue, IssueCode, Preview, PreviewPage},
    parser::{self, Discovered},
};
use crate::{
    db,
    error::{AppError, AppResult},
    models::Host,
    plugins::security::Lease,
    services::operations::{Budget, Cancellation, Errors},
};
use rusqlite::Connection;
use std::{
    collections::{BTreeMap, HashSet},
    sync::LazyLock,
};
use tauri::{AppHandle, Manager};

static WORKERS: LazyLock<Budget> = LazyLock::new(|| {
    Budget::new(
        2,
        Errors {
            domain: "sshImport",
            busy: "sshImport.busy",
            cancelled: "sshImport.cancelled",
            failed: "sshImport.readFailed",
        },
    )
});

pub(crate) async fn preview(app: &AppHandle) -> AppResult<Preview> {
    source_task(
        app,
        None,
        |conn, source, _| preview_at(conn, source),
        std::convert::identity,
    )
    .await
}

const READ: &[&str] = &["hosts.sshConfig.read"];
const IMPORT: &[&str] = &["hosts.sshConfig.read", "hosts.write"];

pub(crate) async fn preview_page(
    app: &AppHandle,
    lease: Lease,
    offset: usize,
    revision: Option<String>,
) -> AppResult<PreviewPage> {
    if offset > 1024
        || (offset > 0 && revision.is_none())
        || revision.as_ref().is_some_and(|value| value.len() != 64)
    {
        return Err(AppError::validation("sshImport.invalidSelection"));
    }
    source_task(
        app,
        Some((lease, READ)),
        move |conn, source, _| page_at(conn, source, offset, revision.as_deref()),
        std::convert::identity,
    )
    .await
}

fn page_at(
    conn: &Connection,
    source: &Discovered,
    offset: usize,
    revision: Option<&str>,
) -> AppResult<PreviewPage> {
    if let Some(revision) = revision {
        match_revision(source, revision)?;
    }
    PreviewPage::from_preview(preview_at(conn, source)?, offset)
}

async fn source_task<T: Send + 'static>(
    app: &AppHandle,
    authority: Option<(Lease, &'static [&'static str])>,
    run: impl FnOnce(&Connection, &Discovered, &Cancellation) -> AppResult<T> + Send + 'static,
    publish: impl FnOnce(T) -> T + Send + 'static,
) -> AppResult<T> {
    let app = app.clone();
    WORKERS
        .blocking(move |cancel| {
            let state = app.state::<crate::state::AppState>();
            if let Some((lease, _)) = &authority {
                state.plugins.security.authorize(
                    &lease.id,
                    &lease.fingerprint,
                    &lease.permissions,
                    None,
                    Some(lease.generation),
                )?;
            }
            cancel.check()?;
            let home = app
                .path()
                .home_dir()
                .map_err(|_| AppError::validation("sshImport.noHome"))?;
            let discovered = parser::discover(&home)?;
            cancel.check()?;
            let result = if let Some((lease, permissions)) = authority {
                state.plugins.security.with_authorized_database(
                    &state.db,
                    &lease,
                    permissions,
                    || cancel.check(),
                    |conn| run(conn, &discovered, cancel),
                )
            } else {
                state.db.with(|conn| {
                    cancel.check()?;
                    run(conn, &discovered, cancel)
                })
            }?;
            Ok(publish(result))
        })
        .await
}

pub(crate) async fn import(
    app: &AppHandle,
    aliases: Vec<String>,
    revision: String,
) -> AppResult<ImportResult> {
    import_checked(app, aliases, revision, None).await
}

pub(crate) async fn import_checked(
    app: &AppHandle,
    aliases: Vec<String>,
    revision: String,
    lease: Option<Lease>,
) -> AppResult<ImportResult> {
    if aliases.is_empty()
        || aliases.len() > 1024
        || revision.len() != 64
        || aliases.iter().any(|a| a.len() > 320)
    {
        return Err(AppError::validation("sshImport.invalidSelection"));
    }
    let handle = app.clone();
    // Publish from the retained worker even if the caller drops its response
    // after the transaction has already been admitted.
    source_task(
        app,
        lease.map(|lease| (lease, IMPORT)),
        move |conn, source, cancel| {
            match_revision(source, &revision)?;
            import_at(conn, source, &aliases, || cancel.commit())
        },
        move |result: ImportResult| {
            let state = handle.state::<crate::state::AppState>();
            super::super::service(&handle, &state).published_import(&result.imported);
            result
        },
    )
    .await
}

fn same_destination(host: &Host, entry: &Entry) -> bool {
    entry.input.as_ref().is_some_and(|input| {
        host.name == input.name
            && host.host == input.host
            && host.port == input.port
            && host.username == input.username
            && host.auth_method == input.auth_method
            && host.key_path == input.key_path
    })
}

/// Return the flat route consumed by the connection layer, not a nested route graph.
fn flatten<'a>(
    alias: &'a str,
    entries: &'a BTreeMap<&str, &Entry>,
    stack: &mut HashSet<&'a str>,
) -> Result<Vec<String>, Issue> {
    if stack.len() > 8 || !stack.insert(alias) {
        return Err(Issue::new(
            IssueCode::InvalidValue,
            "ProxyJump cycle or depth",
        ));
    }
    let result = (|| {
        let entry = entries
            .get(alias)
            .ok_or_else(|| Issue::new(IssueCode::MissingJump, alias))?;
        if entry.input.is_none() || !entry.issues.is_empty() {
            return Err(Issue::new(IssueCode::MissingJump, alias));
        }
        let mut route = Vec::new();
        let mut seen = HashSet::new();
        for jump in &entry.jump_aliases {
            for hop in flatten(jump, entries, stack)?
                .into_iter()
                .chain(std::iter::once(jump.clone()))
            {
                if hop == alias || !seen.insert(hop.clone()) || route.len() >= 8 {
                    return Err(Issue::new(
                        IssueCode::InvalidValue,
                        "ProxyJump cycle or depth",
                    ));
                }
                route.push(hop);
            }
        }
        Ok(route)
    })();
    stack.remove(alias);
    result
}

fn preview_at(conn: &Connection, discovered: &Discovered) -> AppResult<Preview> {
    let mut preview = discovered.preview.clone();
    let hosts = db::hosts::list_hosts(conn)?;
    for entry in &mut preview.entries {
        // Validate before showing an entry as importable. HostInput validation is
        // shared with manual creation, including the application's alias limits.
        if entry.input.as_ref().is_some_and(|input| {
            input.clone().into_host_input().validate().is_err()
                || input
                    .key_path
                    .as_ref()
                    .is_some_and(|path| path.chars().count() > 1024)
        }) {
            entry
                .issues
                .push(Issue::new(IssueCode::InvalidValue, "Host"));
        }
        let matches: Vec<_> = hosts
            .iter()
            .filter(|host| host.name == entry.alias)
            .collect();
        if !matches.is_empty() {
            if matches.len() == 1 && same_destination(matches[0], entry) {
                entry.existing_id = Some(matches[0].id.clone());
            } else {
                entry
                    .issues
                    .push(Issue::new(IssueCode::ExistingConflict, &entry.alias));
            }
        }
    }
    let entries: BTreeMap<_, _> = preview
        .entries
        .iter()
        .map(|entry| (entry.alias.as_str(), entry))
        .collect();
    let route_issues: Vec<_> = preview
        .entries
        .iter()
        .map(|entry| flatten(&entry.alias, &entries, &mut HashSet::new()).err())
        .collect();
    for (entry, issue) in preview.entries.iter_mut().zip(route_issues) {
        if let Some(issue) = issue {
            // The original unsupported option is more useful than a self-reference.
            if entry.issues.is_empty() {
                entry.issues.push(issue);
            }
        }
    }
    Ok(preview)
}

#[cfg(test)]
fn import_from(
    db: &db::Database,
    home: &std::path::Path,
    aliases: &[String],
    revision: &str,
    admit: impl FnOnce() -> AppResult<()>,
) -> AppResult<ImportResult> {
    let discovered = parser::discover(home)?;
    match_revision(&discovered, revision)?;
    db.with(|conn| import_at(conn, &discovered, aliases, admit))
}

fn match_revision(discovered: &Discovered, revision: &str) -> AppResult<()> {
    if discovered.preview.revision != revision {
        return Err(AppError::validation("sshImport.changed"));
    }
    Ok(())
}

fn import_at(
    conn: &Connection,
    discovered: &Discovered,
    aliases: &[String],
    admit: impl FnOnce() -> AppResult<()>,
) -> AppResult<ImportResult> {
    db::atomic(conn, |conn| {
        let preview = preview_at(conn, discovered)?;
        let entries: BTreeMap<_, _> = preview
            .entries
            .iter()
            .map(|e| (e.alias.as_str(), e))
            .collect();
        let mut selected = Vec::new();
        let mut seen = HashSet::new();
        for alias in aliases {
            let route = flatten(alias, &entries, &mut HashSet::new())
                .map_err(|_| AppError::validation("sshImport.invalidSelection"))?;
            for item in route.into_iter().chain(std::iter::once(alias.clone())) {
                if seen.insert(item.clone()) {
                    selected.push(item);
                }
            }
        }
        if selected.is_empty() {
            return Err(AppError::validation("sshImport.invalidSelection"));
        }
        admit()?;
        let mut ids = BTreeMap::new();
        let mut imported = Vec::new();
        let mut skipped = 0;
        for alias in &selected {
            let entry = entries[alias.as_str()];
            if let Some(id) = &entry.existing_id {
                ids.insert(alias.clone(), id.clone());
                skipped += 1;
            } else {
                let draft = entry
                    .input
                    .clone()
                    .ok_or_else(|| AppError::validation("sshImport.invalidSelection"))?
                    .into_host_input()
                    .validate()?;
                let host = db::hosts::create_host(conn, &draft)?;
                ids.insert(alias.clone(), host.id.clone());
                imported.push(host);
            }
        }
        for host in &imported {
            let route = flatten(&host.name, &entries, &mut HashSet::new())
                .map_err(|_| AppError::validation("sshImport.invalidSelection"))?;
            let jump_hosts = route.iter().map(|alias| ids[alias].clone()).collect();
            crate::network::save_route_at(
                conn,
                &host.id,
                &crate::network::ConnectionRoute {
                    proxy: String::new(),
                    jump_hosts,
                },
            )?;
        }
        Ok(ImportResult { imported, skipped })
    })
}

#[cfg(test)]
#[path = "service_tests.rs"]
mod tests;
