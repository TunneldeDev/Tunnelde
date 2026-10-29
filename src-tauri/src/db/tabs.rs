// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

use rusqlite::{params, Connection};

use crate::error::AppResult;
use crate::models::TabRecord;

pub fn list(conn: &Connection) -> AppResult<Vec<TabRecord>> {
    let mut stmt = conn.prepare(
        "SELECT id, kind, title, host_id, sort_order, pinned, state
         FROM tabs ORDER BY sort_order ASC",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(TabRecord {
            id: row.get(0)?,
            kind: row.get(1)?,
            title: row.get(2)?,
            host_id: row.get(3)?,
            sort_order: row.get(4)?,
            pinned: row.get::<_, i64>(5)? != 0,
            state: row.get(6)?,
        })
    })?;

    let mut tabs = Vec::new();
    for row in rows {
        tabs.push(row?);
    }
    Ok(tabs)
}

pub fn save_all(conn: &Connection, tabs: &[TabRecord]) -> AppResult<()> {
    let tx = conn.unchecked_transaction()?;
    tx.execute("DELETE FROM tabs", [])?;
    {
        let mut stmt = tx.prepare(
            "INSERT INTO tabs (id, kind, title, host_id, sort_order, pinned, state)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        )?;
        for (index, tab) in tabs.iter().enumerate() {
            stmt.execute(params![
                tab.id,
                tab.kind,
                tab.title,
                tab.host_id,
                index as i64,
                tab.pinned as i64,
                tab.state,
            ])?;
        }
    }
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;

    fn record(id: &str, kind: &str) -> TabRecord {
        TabRecord {
            id: id.into(),
            kind: kind.into(),
            title: id.into(),
            host_id: None,
            sort_order: 0,
            pinned: false,
            state: None,
        }
    }

    #[test]
    fn saves_and_replaces_tabs() {
        let db = Database::in_memory().expect("database");
        db.with(|conn| {
            save_all(
                conn,
                &[
                    record("page:welcome", "welcome"),
                    record("page:settings", "settings"),
                ],
            )?;
            let tabs = list(conn)?;
            assert_eq!(
                tabs.iter().map(|tab| tab.id.as_str()).collect::<Vec<_>>(),
                vec!["page:welcome", "page:settings"]
            );

            save_all(conn, &[])?;
            assert!(list(conn)?.is_empty());
            Ok(())
        })
        .expect("tabs round trip");
    }
}
