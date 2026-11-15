//! Nested domain mutations retain rollback even when their caller catches errors.
use super::*;

struct Guard<'a> {
    conn: &'a Connection,
    active: bool,
}
impl Drop for Guard<'_> {
    fn drop(&mut self) {
        if self.active {
            if let Err(error) = self.conn.execute_batch(
                "ROLLBACK TO tunnelde_domain_mutation; RELEASE tunnelde_domain_mutation",
            ) {
                tracing::error!(target: "database", %error, "Could not roll back domain savepoint");
            }
        }
    }
}

pub(crate) fn run<T>(
    conn: &Connection,
    effect: impl FnOnce(&Connection) -> AppResult<T>,
) -> AppResult<T> {
    // Same-name nesting is intentional: SQLite resolves the innermost savepoint.
    conn.execute_batch("SAVEPOINT tunnelde_domain_mutation")?;
    let mut guard = Guard { conn, active: true };
    let value = effect(conn)?;
    conn.execute_batch("RELEASE tunnelde_domain_mutation")?;
    guard.active = false;
    Ok(value)
}
