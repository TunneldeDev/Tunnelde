use super::contract::{self, Entry, Group, Rule, Save};
use crate::error::{AppError, AppResult};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{de::DeserializeOwned, Serialize};

pub(crate) trait Record: Serialize + DeserializeOwned + Clone {
    const TABLE: &'static str;
    const MAX_HOST: u32;
    const MAX_TOTAL: u32;
    fn id(&self) -> &str;
    fn host_id(&self) -> &str;
    fn group_id(&self) -> Option<&str> {
        None
    }
    fn validate(&self) -> AppResult<()>;
}
impl Record for Group {
    const TABLE: &'static str = "mount_groups";
    const MAX_HOST: u32 = 32;
    const MAX_TOTAL: u32 = 512;
    fn id(&self) -> &str {
        &self.id
    }
    fn host_id(&self) -> &str {
        &self.host_id
    }
    fn validate(&self) -> AppResult<()> {
        contract::validate_group(self)
    }
}
impl Record for Rule {
    const TABLE: &'static str = "mount_rules";
    const MAX_HOST: u32 = 128;
    const MAX_TOTAL: u32 = 2048;
    fn id(&self) -> &str {
        &self.id
    }
    fn host_id(&self) -> &str {
        &self.host_id
    }
    fn group_id(&self) -> Option<&str> {
        Some(&self.group_id)
    }
    fn validate(&self) -> AppResult<()> {
        contract::validate_rule(self)
    }
}
fn invalid() -> AppError {
    AppError::validation("mounts.rules.invalid")
}
pub(crate) fn changed() -> AppError {
    AppError::validation("mounts.rules.changed")
}
pub(crate) fn revision(conn: &Connection) -> AppResult<String> {
    Ok(
        conn.query_row("SELECT revision FROM mount_state WHERE id=1", [], |row| {
            row.get(0)
        })?,
    )
}
pub(crate) fn check_revision(conn: &Connection, expected: Option<&str>) -> AppResult<String> {
    let current = revision(conn)?;
    if expected.is_some_and(|expected| expected != current) {
        return Err(changed());
    }
    Ok(current)
}
fn decode<T: Record>(
    id: String,
    host: String,
    group: Option<String>,
    revision: Option<String>,
    raw: Option<String>,
) -> AppResult<Entry<T>> {
    let value: T = serde_json::from_str(&raw.ok_or_else(invalid)?)?;
    if value.id() != id || value.host_id() != host || value.group_id() != group.as_deref() {
        return Err(invalid());
    }
    Ok(Entry {
        revision: revision.ok_or_else(invalid)?,
        value,
    })
}
fn columns<T: Record>() -> String {
    format!("id,host_id,{},CASE WHEN length(CAST(revision AS BLOB))<=128 THEN revision END,CASE WHEN length(CAST(value AS BLOB))<=8192 THEN value END", if T::TABLE == "mount_rules" {"group_id"} else {"NULL"})
}
pub(crate) fn get<T: Record>(conn: &Connection, id: &str) -> AppResult<Option<Entry<T>>> {
    let row = conn
        .query_row(
            &format!("SELECT {} FROM {} WHERE id=?1", columns::<T>(), T::TABLE),
            [id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .optional()?;
    row.map(|(id, host, group, revision, raw)| decode(id, host, group, revision, raw))
        .transpose()
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page<T> {
    pub revision: String,
    pub items: Vec<Entry<T>>,
    pub next_cursor: Option<String>,
}
pub(crate) fn page<T: Record>(
    conn: &Connection,
    host: Option<&str>,
    cursor: Option<&str>,
    expected: Option<&str>,
    limit: usize,
) -> AppResult<Page<T>> {
    if cursor.is_some() && expected.is_none() {
        return Err(changed());
    }
    if !(1..=32).contains(&limit) {
        return Err(invalid());
    }
    let revision = check_revision(conn, expected)?;
    if let Some(host) = host {
        crate::db::hosts::find_host(conn, host)?;
    }
    let mut statement = conn.prepare(&format!("SELECT {} FROM {} WHERE (?1 IS NULL OR host_id=?1) AND id>?2 ORDER BY id COLLATE BINARY LIMIT ?3", columns::<T>(), T::TABLE))?;
    let mut rows = statement.query(params![host, cursor.unwrap_or(""), (limit + 1) as u32])?;
    let mut items = Vec::new();
    while let Some(row) = rows.next()? {
        items.push(decode::<T>(
            row.get(0)?,
            row.get(1)?,
            row.get(2)?,
            row.get(3)?,
            row.get(4)?,
        )?);
    }
    let next_cursor = if items.len() > limit {
        items.pop();
        items.last().map(|item| item.value.id().to_owned())
    } else {
        None
    };
    Ok(Page {
        revision,
        items,
        next_cursor,
    })
}
pub(crate) fn all<T: Record>(conn: &Connection, host: Option<&str>) -> AppResult<Vec<Entry<T>>> {
    let mut result = Vec::new();
    let mut cursor = None;
    let revision = revision(conn)?;
    loop {
        let page = page::<T>(conn, host, cursor.as_deref(), Some(&revision), 32)?;
        result.extend(page.items);
        cursor = page.next_cursor;
        if cursor.is_none() {
            return Ok(result);
        }
    }
}
pub(crate) fn save<T: Record>(conn: &Connection, request: Save<T>) -> AppResult<Entry<T>> {
    request.value.validate()?;
    let prior = get::<T>(conn, request.value.id())?;
    match (&prior, &request.expected_revision) {
        (None, None) => {}
        (Some(prior), Some(expected))
            if prior.revision == *expected && prior.value.host_id() == request.value.host_id() => {}
        _ => return Err(changed()),
    }
    crate::db::hosts::find_host(conn, request.value.host_id())?;
    if let Some(group_id) = request.value.group_id() {
        let group = get::<Group>(conn, group_id)?.ok_or_else(invalid)?;
        if group.value.host_id != request.value.host_id() {
            return Err(invalid());
        }
    }
    if prior.is_none() {
        let counts: (u32, u32) = conn.query_row(
            &format!(
                "SELECT count(*),coalesce(sum(host_id=?1),0) FROM {}",
                T::TABLE
            ),
            [request.value.host_id()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        if counts.0 >= T::MAX_TOTAL || counts.1 >= T::MAX_HOST {
            return Err(AppError::validation("mounts.rules.limit"));
        }
    }
    let revision = uuid::Uuid::new_v4().to_string();
    let raw = serde_json::to_string(&request.value)?;
    if raw.len() > 8192 {
        return Err(invalid());
    }
    if let Some(group) = request.value.group_id() {
        conn.execute("INSERT INTO mount_rules(id,host_id,group_id,revision,value) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(id) DO UPDATE SET group_id=excluded.group_id,revision=excluded.revision,value=excluded.value",params![request.value.id(),request.value.host_id(),group,revision,raw])?;
    } else {
        conn.execute("INSERT INTO mount_groups(id,host_id,revision,value) VALUES(?1,?2,?3,?4) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,value=excluded.value",params![request.value.id(),request.value.host_id(),revision,raw])?;
    }
    Ok(Entry {
        revision,
        value: request.value,
    })
}
pub(crate) fn remove<T: Record>(conn: &Connection, id: &str, expected: &str) -> AppResult<()> {
    let current = get::<T>(conn, id)?.ok_or_else(changed)?;
    if current.revision != expected {
        return Err(changed());
    }
    conn.execute(&format!("DELETE FROM {} WHERE id=?1", T::TABLE), [id])?;
    Ok(())
}
