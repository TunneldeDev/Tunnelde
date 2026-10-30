// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

use rusqlite::{params, Connection, OptionalExtension};

use crate::error::{AppError, AppResult};
use crate::models::{now_ms, Group, Host, HostDraft};

fn map_host(row: &rusqlite::Row<'_>) -> rusqlite::Result<Host> {
    let tags: String = row.get("tags")?;
    let port: i64 = row.get("port")?;
    let favorite: i64 = row.get("favorite")?;
    Ok(Host {
        id: row.get("id")?,
        group_id: row.get("group_id")?,
        name: row.get("name")?,
        host: row.get("host")?,
        port: port.clamp(1, 65535) as u16,
        username: row.get("username")?,
        auth_method: row.get("auth_method")?,
        key_path: row.get("key_path")?,
        favorite: favorite != 0,
        color: row.get("color")?,
        tags: serde_json::from_str(&tags).unwrap_or_default(),
        note: row.get("note")?,
        last_used_at: row.get("last_used_at")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

pub fn list_hosts(conn: &Connection) -> AppResult<Vec<Host>> {
    let mut stmt = conn.prepare(
        "SELECT * FROM hosts
         ORDER BY favorite DESC, name COLLATE NOCASE ASC",
    )?;
    let rows = stmt.query_map([], map_host)?;
    let mut hosts = Vec::new();
    for row in rows {
        hosts.push(row?);
    }
    Ok(hosts)
}

pub fn find_host(conn: &Connection, id: &str) -> AppResult<Host> {
    conn.query_row("SELECT * FROM hosts WHERE id = ?1", params![id], map_host)
        .optional()?
        .ok_or_else(|| AppError::NotFound("host.notFound".into()))
}

pub fn create_host(conn: &Connection, draft: &HostDraft) -> AppResult<Host> {
    let id = uuid::Uuid::new_v4().to_string();
    let ts = now_ms();
    conn.execute(
        "INSERT INTO hosts
         (id, group_id, name, host, port, username, auth_method, key_path, favorite, color, tags,
          note, last_used_at, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, NULL, ?13, ?13)",
        params![
            id,
            draft.group_id,
            draft.name,
            draft.host,
            draft.port as i64,
            draft.username,
            draft.auth_method,
            draft.key_path,
            draft.favorite as i64,
            draft.color,
            serde_json::to_string(&draft.tags)?,
            draft.note,
            ts,
        ],
    )?;
    find_host(conn, &id)
}

pub fn update_host(conn: &Connection, id: &str, draft: &HostDraft) -> AppResult<Host> {
    let changed = conn.execute(
        "UPDATE hosts SET
            group_id = ?2, name = ?3, host = ?4, port = ?5, username = ?6, auth_method = ?7,
            key_path = ?8, favorite = ?9, color = ?10, tags = ?11, note = ?12, updated_at = ?13
         WHERE id = ?1",
        params![
            id,
            draft.group_id,
            draft.name,
            draft.host,
            draft.port as i64,
            draft.username,
            draft.auth_method,
            draft.key_path,
            draft.favorite as i64,
            draft.color,
            serde_json::to_string(&draft.tags)?,
            draft.note,
            now_ms(),
        ],
    )?;
    if changed == 0 {
        return Err(AppError::NotFound("host.notFound".into()));
    }
    find_host(conn, id)
}

pub fn delete_host(conn: &Connection, id: &str) -> AppResult<()> {
    let changed = conn.execute("DELETE FROM hosts WHERE id = ?1", params![id])?;
    if changed == 0 {
        return Err(AppError::NotFound("host.notFound".into()));
    }
    Ok(())
}

pub fn mark_used(conn: &Connection, id: &str) -> AppResult<()> {
    conn.execute(
        "UPDATE hosts SET last_used_at = ?2 WHERE id = ?1",
        params![id, now_ms()],
    )?;
    Ok(())
}

fn map_group(row: &rusqlite::Row<'_>) -> rusqlite::Result<Group> {
    Ok(Group {
        id: row.get("id")?,
        name: row.get("name")?,
        parent_id: row.get("parent_id")?,
        sort_order: row.get("sort_order")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

pub fn list_groups(conn: &Connection) -> AppResult<Vec<Group>> {
    let mut stmt =
        conn.prepare("SELECT * FROM groups ORDER BY sort_order ASC, name COLLATE NOCASE ASC")?;
    let rows = stmt.query_map([], map_group)?;
    let mut groups = Vec::new();
    for row in rows {
        groups.push(row?);
    }
    Ok(groups)
}

pub fn create_group(conn: &Connection, name: &str, parent_id: Option<&str>) -> AppResult<Group> {
    if let Some(parent) = parent_id {
        if !exists(conn, "groups", parent)? {
            return Err(AppError::NotFound("group.notFound".into()));
        }
    }
    let id = uuid::Uuid::new_v4().to_string();
    let ts = now_ms();
    let sort_order: i64 = conn.query_row(
        "SELECT COALESCE(MAX(sort_order), 0) + 1 FROM groups",
        [],
        |row| row.get(0),
    )?;
    conn.execute(
        "INSERT INTO groups (id, name, parent_id, sort_order, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
        params![id, name, parent_id, sort_order, ts],
    )?;
    Ok(conn.query_row("SELECT * FROM groups WHERE id = ?1", params![id], map_group)?)
}

pub fn update_group(
    conn: &Connection,
    id: &str,
    name: &str,
    parent_id: Option<&str>,
) -> AppResult<Group> {
    if let Some(parent) = parent_id {
        if parent == id {
            return Err(AppError::validation("group.parent.self"));
        }
        if is_descendant(conn, id, parent)? {
            return Err(AppError::validation("group.parent.cycle"));
        }
    }
    let changed = conn.execute(
        "UPDATE groups SET name = ?2, parent_id = ?3, updated_at = ?4 WHERE id = ?1",
        params![id, name, parent_id, now_ms()],
    )?;
    if changed == 0 {
        return Err(AppError::NotFound("group.notFound".into()));
    }
    Ok(conn.query_row("SELECT * FROM groups WHERE id = ?1", params![id], map_group)?)
}

pub fn delete_group(conn: &Connection, id: &str) -> AppResult<()> {
    let changed = conn.execute("DELETE FROM groups WHERE id = ?1", params![id])?;
    if changed == 0 {
        return Err(AppError::NotFound("group.notFound".into()));
    }
    Ok(())
}

fn exists(conn: &Connection, table: &str, id: &str) -> AppResult<bool> {
    let sql = format!("SELECT 1 FROM {table} WHERE id = ?1");
    let found: Option<i64> = conn
        .query_row(&sql, params![id], |row| row.get(0))
        .optional()?;
    Ok(found.is_some())
}

/// Walks up from `candidate` to make sure `id` is not one of its ancestors.
fn is_descendant(conn: &Connection, id: &str, candidate: &str) -> AppResult<bool> {
    let mut cursor = Some(candidate.to_string());
    let mut hops = 0;
    while let Some(current) = cursor {
        if current == id {
            return Ok(true);
        }
        hops += 1;
        if hops > 64 {
            return Ok(true);
        }
        cursor = conn
            .query_row(
                "SELECT parent_id FROM groups WHERE id = ?1",
                params![current],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten();
    }
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;
    use crate::models::HostInput;

    fn draft(name: &str, group_id: Option<&str>) -> HostDraft {
        HostInput {
            name: name.into(),
            group_id: group_id.map(str::to_string),
            host: "example.com".into(),
            port: Some(22),
            username: Some("root".into()),
            auth_method: Some("password".into()),
            key_path: None,
            favorite: false,
            color: None,
            tags: Vec::new(),
            note: None,
        }
        .validate()
        .expect("valid host")
    }

    #[test]
    fn round_trips_hosts() {
        let db = Database::in_memory().expect("database");
        db.with(|conn| {
            let group = create_group(conn, "Production", None)?;
            let host = create_host(conn, &draft("api", Some(&group.id)))?;
            assert_eq!(host.group_id.as_deref(), Some(group.id.as_str()));
            assert_eq!(list_hosts(conn)?.len(), 1);

            let mut updated = draft("api-v2", None);
            updated.favorite = true;
            let updated = update_host(conn, &host.id, &updated)?;
            assert_eq!(updated.name, "api-v2");
            assert!(updated.favorite);
            assert!(updated.group_id.is_none());

            mark_used(conn, &host.id)?;
            assert!(find_host(conn, &host.id)?.last_used_at.is_some());

            delete_host(conn, &host.id)?;
            assert!(list_hosts(conn)?.is_empty());
            Ok(())
        })
        .expect("host round trip");
    }

    #[test]
    fn rejects_group_cycles() {
        let db = Database::in_memory().expect("database");
        db.with(|conn| {
            let parent = create_group(conn, "Parent", None)?;
            let child = create_group(conn, "Child", Some(&parent.id))?;

            let cycle = update_group(conn, &parent.id, "Parent", Some(&child.id)).unwrap_err();
            assert!(matches!(cycle, AppError::Validation(_)));

            let itself = update_group(conn, &parent.id, "Parent", Some(&parent.id)).unwrap_err();
            assert!(matches!(itself, AppError::Validation(_)));

            let renamed = update_group(conn, &child.id, "Child 2", Some(&parent.id))?;
            assert_eq!(renamed.name, "Child 2");
            Ok(())
        })
        .expect("group cycles");
    }

    #[test]
    fn keeps_hosts_when_their_group_is_deleted() {
        let db = Database::in_memory().expect("database");
        db.with(|conn| {
            let group = create_group(conn, "Temporary", None)?;
            let host = create_host(conn, &draft("worker", Some(&group.id)))?;
            delete_group(conn, &group.id)?;
            let host = find_host(conn, &host.id)?;
            assert!(host.group_id.is_none());
            Ok(())
        })
        .expect("group delete");
    }

    #[test]
    fn reports_missing_entities() {
        let db = Database::in_memory().expect("database");
        db.with(|conn| {
            let error = delete_host(conn, "missing").unwrap_err();
            assert!(matches!(error, AppError::NotFound(_)));
            assert!(find_host(conn, "missing").is_err());
            Ok(())
        })
        .expect("missing rows");
    }
}
