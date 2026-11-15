use super::*;

pub(crate) fn host_created(conn: &Connection, id: &str) -> AppResult<()> {
    // New/reimported identity must never adopt an old logical-key credential.
    bindings::invalidate(conn, &Owner::host(id)?)
}

pub(crate) fn host_deleted(conn: &Connection, id: &str) -> AppResult<()> {
    bindings::invalidate(conn, &Owner::host(id)?)
}

pub(crate) fn host_changed(conn: &Connection, previous: &Host, next: &Host) -> AppResult<()> {
    if previous.id != next.id
        || previous.host != next.host
        || previous.port != next.port
        || previous.username != next.username
        || previous.auth_method != next.auth_method
        || previous.key_path != next.key_path
    {
        // Destination/authentication identity changed: keep no implicit secret.
        bindings::invalidate(conn, &Owner::host(&previous.id)?)?;
    }
    Ok(())
}

pub(crate) fn route_changed(conn: &Connection, id: &str) -> AppResult<()> {
    // A route edit changes request authority, but preserves the destination's
    // credential. Rotation also rejects A -> B -> A configuration ABA.
    bindings::renew(conn, &Owner::host(id)?)
}

pub(crate) fn host_incarnation(conn: &Connection, id: &str) -> AppResult<Option<Uuid>> {
    Ok(bindings::capture(conn, &Owner::host(id)?)?.incarnation())
}
