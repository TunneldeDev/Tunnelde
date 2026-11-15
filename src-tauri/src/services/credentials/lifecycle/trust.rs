//! SSH endpoint trust lineage survives forget/reapprove and A -> B -> A.
use super::*;

fn key(host: &str, port: i64) -> String {
    use sha2::{Digest, Sha256};
    let mut digest = Sha256::new();
    digest.update(b"tunnelde.ssh.trust.v1\0");
    digest.update((host.len() as u64).to_le_bytes());
    digest.update(host.as_bytes());
    digest.update(port.to_le_bytes());
    format!("credentials.trust.{:x}", digest.finalize())
}

pub(crate) fn trust_changed(conn: &Connection, host: &str, port: i64) -> AppResult<()> {
    if conn.is_autocommit() {
        return Err(crate::error::AppError::internal(
            "credentials.transactionRequired",
        ));
    }
    revisions::rotate(conn, &key(host, port))
}

pub(crate) fn trust_incarnation(
    conn: &Connection,
    host: &str,
    port: i64,
) -> AppResult<Option<Uuid>> {
    revisions::read(conn, &key(host, port))
}
