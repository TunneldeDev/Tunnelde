//! Host-scoped groups and membership. Moving a running rule is rejected by the
//! same registry edit lock used for endpoint edits; the revision fences starts.
use crate::{
    db::Database,
    error::{AppError, AppResult},
    ssh::forward::ForwardRegistry,
};
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Group {
    pub id: String,
    pub host_id: String,
    pub name: String,
    pub revision: String,
}
pub(crate) fn list(conn: &Connection, host: Option<&str>) -> AppResult<Vec<Group>> {
    let mut stmt =
        conn.prepare("SELECT value FROM settings WHERE key LIKE 'forward-group:%' ORDER BY key")?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
    let mut groups = Vec::new();
    for row in rows {
        let group: Group = serde_json::from_str(&row?)?;
        if host.is_none_or(|host| host == group.host_id) {
            groups.push(group);
        }
    }
    Ok(groups)
}
pub(crate) fn membership(conn: &Connection, id: &str) -> AppResult<Option<String>> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key=?1",
            [format!("forward-membership:{id}")],
            |row| row.get(0),
        )
        .optional()?;
    raw.map(|raw| serde_json::from_str(&raw).map_err(Into::into))
        .transpose()
}
pub(crate) fn validate_membership(
    conn: &Connection,
    host: &str,
    group: Option<&str>,
) -> AppResult<()> {
    if let Some(id) = group {
        if !list(conn, Some(host))?.iter().any(|group| group.id == id) {
            return Err(AppError::validation("forward.groupMissing"));
        }
    }
    Ok(())
}
pub(crate) fn save_at(
    conn: &Connection,
    id: Option<&str>,
    host: &str,
    name: &str,
    expected: Option<&str>,
) -> AppResult<Group> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 80 || name.chars().any(char::is_control) {
        return Err(AppError::validation("forward.groupInvalid"));
    }
    crate::db::hosts::find_host(conn, host)?;
    let groups = list(conn, None)?;
    if let Some(id) = id {
        if !groups.iter().any(|group| {
            group.id == id && group.host_id == host && Some(group.revision.as_str()) == expected
        }) {
            return Err(AppError::validation("forward.changed"));
        }
    } else if expected.is_some() {
        return Err(AppError::validation("forward.changed"));
    }
    if id.is_none()
        && (groups.len() >= 512
            || groups.iter().filter(|group| group.host_id == host).count() >= 32)
    {
        return Err(AppError::validation("forward.groupLimit"));
    }
    let group = Group {
        id: id
            .map(str::to_owned)
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
        host_id: host.into(),
        name: name.into(),
        revision: uuid::Uuid::new_v4().to_string(),
    };
    put(conn, &format!("forward-group:{}", group.id), &group)?;
    Ok(group)
}
fn put(conn: &Connection, key: &str, value: &impl Serialize) -> AppResult<()> {
    conn.execute("INSERT INTO settings(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at", rusqlite::params![key,serde_json::to_string(value)?,crate::models::now_ms()])?;
    Ok(())
}
pub(crate) fn assign_at(
    conn: &Connection,
    id: &str,
    host: &str,
    group: Option<&str>,
) -> AppResult<()> {
    validate_membership(conn, host, group)?;
    if let Some(group) = group {
        put(conn, &format!("forward-membership:{id}"), &group)?;
    } else {
        conn.execute(
            "DELETE FROM settings WHERE key=?1",
            [format!("forward-membership:{id}")],
        )?;
    }
    Ok(())
}
pub(crate) fn move_rule(
    db: &Database,
    registry: &ForwardRegistry,
    id: &str,
    expected: &str,
    group: Option<&str>,
) -> AppResult<super::contract::RevisionedRule> {
    registry.edit(id, || {
        db.with(|conn| {
            crate::db::atomic(conn, |conn| {
                let mut entry = super::repository::find(conn, id)?
                    .ok_or_else(|| AppError::validation("forward.missing"))?;
                if entry.revision != expected {
                    return Err(AppError::validation("forward.changed"));
                }
                let options = super::automation::settings::read(conn, id, &entry.revision)?;
                assign_at(conn, id, &entry.rule.host_id, group)?;
                entry.group_id = group.map(str::to_owned);
                entry.revision = uuid::Uuid::new_v4().to_string();
                put(conn, &format!("forward-version:{id}"), &entry.revision)?;
                super::automation::settings::write(conn, id, &entry.revision, options)?;
                Ok(entry)
            })
        })
    })
}
pub(crate) fn remove(
    db: &Database,
    registry: &ForwardRegistry,
    id: &str,
    expected: &str,
) -> AppResult<()> {
    // Keep members intact: users must move rules out before deleting a group.
    registry.inspect(|_| db.with(|conn| crate::db::atomic(conn, |conn| {
        if !list(conn, None)?.iter().any(|group| group.id == id && group.revision == expected) { return Err(AppError::validation("forward.changed")); }
        let count: u32 = conn.query_row("SELECT count(*) FROM settings WHERE key LIKE 'forward-membership:%' AND value=?1", [serde_json::to_string(id)?], |row| row.get(0))?;
        if count != 0 { return Err(AppError::validation("forward.groupNotEmpty")); }
        conn.execute("DELETE FROM settings WHERE key=?1", [format!("forward-group:{id}")])?;
        Ok(())
    })))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn host(conn: &Connection, name: &str) -> String {
        let input = serde_json::from_value::<crate::models::HostInput>(
            serde_json::json!({"name":name,"host":"example.test"}),
        )
        .unwrap();
        crate::db::hosts::create_host(conn, &input.validate().unwrap())
            .unwrap()
            .id
    }
    fn rule(host: &str) -> super::super::contract::ForwardRule {
        serde_json::from_value(serde_json::json!({"id":"rule","hostId":host,"name":"Rule","mode":"local","bindHost":"127.0.0.1","bindPort":17000,"targetHost":"localhost","targetPort":80})).unwrap()
    }
    #[test]
    fn membership_is_host_scoped_revisioned_and_preserves_automation() {
        let db = Database::in_memory().unwrap();
        let registry = ForwardRegistry::default();
        let (saved, group, foreign) = db
            .with(|conn| {
                let first = host(conn, "First");
                let other = host(conn, "Other");
                let group = save_at(conn, None, &first, "Shared", None)?;
                let foreign = save_at(conn, None, &other, "Other", None)?;
                let rule = rule(&first);
                super::super::repository::import_at(
                    conn,
                    &rule,
                    super::super::automation::Options {
                        auto_start: true,
                        auto_retry: true,
                    },
                    None,
                )?;
                Ok((
                    super::super::repository::find(conn, &rule.id)?.unwrap(),
                    group,
                    foreign,
                ))
            })
            .unwrap();
        assert!(move_rule(
            &db,
            &registry,
            &saved.rule.id,
            &saved.revision,
            Some(&foreign.id)
        )
        .is_err());
        let moved = move_rule(
            &db,
            &registry,
            &saved.rule.id,
            &saved.revision,
            Some(&group.id),
        )
        .unwrap();
        assert_ne!(moved.revision, saved.revision);
        assert_eq!(moved.group_id.as_deref(), Some(group.id.as_str()));
        assert!(move_rule(&db, &registry, &saved.rule.id, &saved.revision, None).is_err());
        db.with(|conn| {
            assert_eq!(
                super::super::automation::settings::read(conn, &moved.rule.id, &moved.revision)?,
                super::super::automation::Options {
                    auto_start: true,
                    auto_retry: true
                }
            );
            Ok(())
        })
        .unwrap();
        assert!(remove(&db, &registry, &group.id, &group.revision).is_err());
        move_rule(&db, &registry, &moved.rule.id, &moved.revision, None).unwrap();
        remove(&db, &registry, &group.id, &group.revision).unwrap();
    }
    #[test]
    fn failed_grouped_save_rolls_back_endpoints_membership_and_revision() {
        let db = Database::in_memory().unwrap();
        let host = db.with(|conn| Ok(host(conn, "Host"))).unwrap();
        let saved =
            super::super::repository::save_configured(&db, &rule(&host), None, Default::default())
                .unwrap();
        let mut changed = saved.rule.clone();
        changed.target_port = 9999;
        assert!(super::super::repository::save_grouped(
            &db,
            &changed,
            Some(&saved.revision),
            Default::default(),
            Some("missing")
        )
        .is_err());
        let current = db
            .with(|conn| super::super::repository::find(conn, &saved.rule.id))
            .unwrap()
            .unwrap();
        assert_eq!(current.rule, saved.rule);
        assert_eq!(current.revision, saved.revision);
        assert!(current.group_id.is_none());
    }
}
