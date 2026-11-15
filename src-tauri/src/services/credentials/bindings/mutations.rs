use super::*;

/// No secret value and no Debug/Serialize surface. The random operation identity
/// is also the immutable physical item identity, recorded before OS mutation.
pub(crate) struct Intent {
    id: Uuid,
    run: Uuid,
    binding: Binding,
    authority: String,
}

impl Intent {
    pub(in crate::services::credentials) fn id(&self) -> Uuid {
        self.id
    }

    pub(in crate::services::credentials) fn physical(&self) -> Physical {
        Physical::Immutable(self.id)
    }
}

/// The caller invokes this only inside its original authority transaction.
pub(in crate::services::credentials) fn begin(
    conn: &Connection,
    binding: &Binding,
    original_authority: &str,
    run: Uuid,
) -> AppResult<Intent> {
    transaction_required(conn)?;
    authority(original_authority)?;
    verify(conn, binding)?;
    // Preserve unresolved operations rather than evicting evidence. A failed
    // platform store cannot grow the durable journal through endless saves.
    let (owned, total): (i64, i64) = conn.query_row(
        "SELECT
         (SELECT COUNT(*) FROM credential_operations WHERE kind=?1 AND owner=?2 AND phase IN ('intent','written'))
         + (SELECT COUNT(*) FROM credential_cleanup WHERE kind=?1 AND owner=?2),
         (SELECT COUNT(*) FROM credential_operations WHERE phase IN ('intent','written'))
         + (SELECT COUNT(*) FROM credential_cleanup)",
        params![binding.owner.kind, binding.owner.id], |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    if owned >= 4 || total >= 256 {
        return Err(AppError::validation("credentials.cleanupRequired"));
    }
    let intent = Intent {
        id: Uuid::new_v4(),
        run,
        binding: binding.clone(),
        authority: original_authority.into(),
    };
    conn.execute(
        "INSERT INTO credential_operations
         (id,kind,owner,run,expected_revision,authority,phase,created_at)
         VALUES (?1,?2,?3,?4,?5,?6,'intent',?7)",
        params![
            intent.id.to_string(),
            binding.owner.kind,
            binding.owner.id,
            run.to_string(),
            binding.revision.map(|r| r.to_string()),
            original_authority,
            crate::models::now_ms()
        ],
    )?;
    Ok(intent)
}

fn phase(conn: &Connection, intent: &Intent) -> AppResult<String> {
    let row = conn.query_row(
        "SELECT kind,owner,run,expected_revision,authority,phase FROM credential_operations WHERE id=?1",
        [intent.id.to_string()],
        |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?,
            r.get::<_, Option<String>>(3)?, r.get::<_, String>(4)?, r.get::<_, String>(5)?)),
    ).optional()?.ok_or_else(corrupt)?;
    if row.0 != intent.binding.owner.kind
        || row.1 != intent.binding.owner.id
        || row.2 != intent.run.to_string()
        || row.3 != intent.binding.revision.map(|r| r.to_string())
        || row.4 != intent.authority
    {
        return Err(corrupt());
    }
    Ok(row.5)
}

/// Record only a confirmed successful OS write. A lost response stays intent;
/// recovery retires that exact item and never repeats the logical write.
pub(in crate::services::credentials) fn written(
    conn: &Connection,
    intent: &Intent,
) -> AppResult<()> {
    transaction_required(conn)?;
    if phase(conn, intent)? != "intent" {
        return Err(stale());
    }
    conn.execute(
        "UPDATE credential_operations SET phase='written' WHERE id=?1",
        [intent.id.to_string()],
    )?;
    Ok(())
}

/// The caller revalidates original host/profile/review/cancellation authority in
/// this transaction. A stale result cannot redirect a prepared secret.
pub(in crate::services::credentials) fn publish(
    conn: &Connection,
    intent: &Intent,
    current_authority: &str,
) -> AppResult<()> {
    transaction_required(conn)?;
    authority(current_authority)?;
    if current_authority != intent.authority || phase(conn, intent)? != "written" {
        return Err(stale());
    }
    verify(conn, &intent.binding)?;
    conn.execute(
        "UPDATE credential_operations SET phase='published' WHERE id=?1",
        [intent.id.to_string()],
    )?;
    write_binding(
        conn,
        &intent.binding.owner,
        Some(intent.physical()),
        intent.binding.incarnation,
    )?;
    cleanup::queue(conn, &intent.binding)?;
    Ok(())
}

/// A failed publication has no authority to remove a replacement binding.
/// Never retire an item after its publication succeeded despite reply loss.
pub(in crate::services::credentials) fn abandon(
    conn: &Connection,
    intent: &Intent,
) -> AppResult<()> {
    transaction_required(conn)?;
    if phase(conn, intent)? == "published" {
        return Ok(());
    }
    conn.execute(
        "UPDATE credential_operations SET phase='abandoned' WHERE id=?1",
        [intent.id.to_string()],
    )?;
    cleanup::queue_item(conn, &intent.binding.owner, &intent.physical())
}
