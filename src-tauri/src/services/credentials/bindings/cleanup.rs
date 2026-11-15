use super::*;

pub(in crate::services::credentials) struct Retirement {
    id: Uuid,
    owner: Owner,
    physical: Physical,
    run: Uuid,
}

impl Retirement {
    pub(in crate::services::credentials) fn physical(&self) -> &Physical {
        &self.physical
    }
}

pub(super) fn queue(conn: &Connection, binding: &Binding) -> AppResult<()> {
    if let Some(physical) = binding.physical() {
        queue_item(conn, &binding.owner, &physical)?;
    }
    Ok(())
}

pub(super) fn queue_item(conn: &Connection, owner: &Owner, physical: &Physical) -> AppResult<()> {
    transaction_required(conn)?;
    let (item, legacy) = match physical {
        Physical::Immutable(id) => (Some(id.to_string()), false),
        Physical::Legacy(actual) if actual == owner => (None, true),
        Physical::Legacy(_) => return Err(corrupt()),
    };
    conn.execute(
        "INSERT INTO credential_cleanup (id,kind,owner,item,legacy,created_at)
         VALUES (?1,?2,?3,?4,?5,?6) ON CONFLICT DO NOTHING",
        params![
            Uuid::new_v4().to_string(),
            owner.kind,
            owner.id,
            item,
            legacy,
            crate::models::now_ms()
        ],
    )?;
    Ok(())
}

/// Startup only, after acquiring exclusive application/database ownership and
/// before creating workers. Never use elapsed time to retire a live operation.
/// This bounded page makes progress without an unbounded scan or OS replay.
pub(in crate::services::credentials) fn recover(
    conn: &Connection,
    run: Uuid,
    limit: usize,
) -> AppResult<usize> {
    transaction_required(conn)?;
    if limit == 0 || limit > 32 {
        return Err(corrupt());
    }
    let mut stmt = conn.prepare(
        "SELECT id,kind,owner FROM credential_operations
         WHERE run<>?1 AND phase IN ('intent','written') ORDER BY created_at,id LIMIT ?2",
    )?;
    let rows = stmt
        .query_map(params![run.to_string(), limit as i64], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    for (id, kind, owner) in &rows {
        let kind = match kind.as_str() {
            "host" => "host",
            "proxy" => "proxy",
            _ => return Err(corrupt()),
        };
        let owner = Owner::new(kind, owner)?;
        let item = parse(id)?;
        conn.execute(
            "UPDATE credential_operations SET phase='abandoned' WHERE id=?1",
            [id],
        )?;
        queue_item(conn, &owner, &Physical::Immutable(item))?;
    }
    // Recover lost cleanup replies by the original queue identity. This never
    // resurrects a binding, repeats a save, or grants arbitrary OS enumeration.
    let released = conn.execute(
        "UPDATE credential_cleanup SET claimed_run=NULL WHERE id IN
        (SELECT id FROM credential_cleanup WHERE claimed_run<>?1 ORDER BY created_at,id LIMIT ?2)",
        params![run.to_string(), (limit - rows.len()) as i64],
    )?;
    // Every recovered record consumes this page's budget. Report released
    // cleanup claims too: returning zero while releasing a full page would
    // strand further old claims when the startup caller stops at zero progress.
    Ok(rows.len() + released)
}

/// Claim in a short transaction, release it, then delete this exact OS item.
/// New saves use unpredictable immutable items and cannot adopt retired items.
pub(in crate::services::credentials) fn claim(
    conn: &Connection,
    run: Uuid,
) -> AppResult<Option<Retirement>> {
    transaction_required(conn)?;
    let row = conn
        .query_row(
            "SELECT id,kind,owner,item,legacy FROM credential_cleanup
         WHERE claimed_run IS NULL ORDER BY created_at,id LIMIT 1",
            [],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, Option<String>>(3)?,
                    r.get::<_, i64>(4)?,
                ))
            },
        )
        .optional()?;
    let Some((id, kind, owner, item, legacy)) = row else {
        return Ok(None);
    };
    let kind = match kind.as_str() {
        "host" => "host",
        "proxy" => "proxy",
        _ => return Err(corrupt()),
    };
    let owner = Owner::new(kind, &owner)?;
    let physical = match (item, legacy) {
        (Some(id), 0) => Physical::Immutable(parse(&id)?),
        (None, 1) => Physical::Legacy(owner.clone()),
        _ => return Err(corrupt()),
    };
    let current = capture(conn, &owner)?;
    if current.physical().as_ref() == Some(&physical) {
        return Err(corrupt());
    }
    if let Physical::Immutable(id) = physical {
        let owns_item: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM credential_operations WHERE id=?1
             AND kind=?2 AND owner=?3 AND phase IN ('abandoned','published'))",
            params![id.to_string(), owner.kind, owner.id],
            |r| r.get(0),
        )?;
        if !owns_item {
            return Err(corrupt());
        }
        let still_active: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM credential_bindings WHERE item=?1)
             OR EXISTS(SELECT 1 FROM credential_operations WHERE id=?1 AND phase IN ('intent','written'))",
            [id.to_string()], |r| r.get(0),
        )?;
        if still_active {
            return Err(corrupt());
        }
    }
    conn.execute(
        "UPDATE credential_cleanup SET claimed_run=?1 WHERE id=?2 AND claimed_run IS NULL",
        params![run.to_string(), id],
    )?;
    Ok(Some(Retirement {
        id: parse(&id)?,
        owner,
        physical,
        run,
    }))
}

/// Call only after successful deletion or confirmed OS absence. On error retain
/// the claimed record; startup/explicit recovery can inspect that same item.
pub(in crate::services::credentials) fn complete(
    conn: &Connection,
    retirement: &Retirement,
) -> AppResult<()> {
    transaction_required(conn)?;
    if capture(conn, &retirement.owner)?.physical().as_ref() == Some(&retirement.physical) {
        return Err(corrupt());
    }
    let removed = conn.execute(
        "DELETE FROM credential_cleanup WHERE id=?1 AND claimed_run=?2",
        params![retirement.id.to_string(), retirement.run.to_string()],
    )?;
    if removed != 1 {
        return Err(stale());
    }
    // Discard completed item metadata, but retain durable owner tombstones.
    if let Physical::Immutable(id) = retirement.physical {
        conn.execute(
            "DELETE FROM credential_operations WHERE id=?1 AND kind=?2 AND owner=?3
             AND phase IN ('published','abandoned')
             AND NOT EXISTS(SELECT 1 FROM credential_bindings WHERE item=?1)
             AND NOT EXISTS(SELECT 1 FROM credential_cleanup WHERE item=?1)",
            params![id.to_string(), retirement.owner.kind, retirement.owner.id],
        )?;
    }
    Ok(())
}
