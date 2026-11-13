use super::super::{sqlite, Binding, Record};
use super::*;
use crate::ssh::files::native_save::contracts;
use rusqlite::{params, Connection, TransactionBehavior};

const CAPACITY: usize = 128;
const MAX_BYTES: usize = 65_536;
const SCHEMA: &str = "CREATE TABLE legacy_claims(id TEXT PRIMARY KEY, revision INTEGER NOT NULL, value TEXT NOT NULL, digest TEXT NOT NULL); PRAGMA user_version=2;";

impl Journal {
    pub fn admission_enabled(&self) -> Result<bool> {
        self.verify()?;
        read_claims(&self.conn, &self.id)?;
        Ok(version(&self.conn)? == 2)
    }
    /// Explicit local format upgrade only. It is not permission to submit writes.
    /// Historical native records are verified and preserved in the same transaction.
    pub fn enable_admission(&mut self) -> Result<()> {
        self.verify()?;
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| Error::Unavailable)?;
        sqlite::read_records(&tx, &self.id)?;
        match version(&tx)? {
            1 => tx.execute_batch(SCHEMA).map_err(|_| Error::Unavailable)?,
            2 => {
                read_claims(&tx, &self.id)?;
            }
            _ => return Err(Error::Unrecognized),
        }
        tx.commit().map_err(|_| Error::Unavailable)?;
        self.schema_version = 2;
        self.verify()
    }
    pub fn legacy_claims(&self) -> Result<Vec<Claim>> {
        self.verify()?;
        read_claims(&self.conn, &self.id)
    }
    pub fn reserve_legacy(
        &mut self,
        kind: Kind,
        owner: Owner,
        scopes: Vec<Scope>,
    ) -> Result<Claim> {
        self.verify()?;
        let claim = Claim {
            journal_id: self.id.clone(),
            id: uuid::Uuid::new_v4().to_string(),
            owner,
            revision: 1,
            kind,
            phase: Phase::Prepared,
            transfer_roots: (kind == Kind::Transfer).then(|| scopes.clone()),
            scopes,
        };
        let (bytes, digest) = encode(&claim)?;
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| Error::Unavailable)?;
        if version(&tx)? != 2 {
            return Err(Error::Unrecognized);
        }
        let native = sqlite::read_records(&tx, &self.id)?;
        let legacy = read_claims(&tx, &self.id)?;
        if native.len() + legacy.len() >= CAPACITY {
            return Err(Error::Capacity);
        }
        if native
            .iter()
            .any(|record| record.blocks_target() && claim.overlaps_native(&record.binding))
            || legacy
                .iter()
                .any(|existing| existing.overlaps(&claim.scopes))
        {
            return Err(Error::Occupied);
        }
        tx.execute(
            "INSERT INTO legacy_claims VALUES(?1,?2,?3,?4)",
            params![claim.id, claim.revision as i64, bytes, digest],
        )
        .map_err(|_| Error::Unavailable)?;
        tx.commit().map_err(|_| Error::Unavailable)?;
        self.verify()?;
        Ok(claim)
    }
    pub fn dispatch_legacy(&mut self, expected: &Claim) -> Result<Dispatched> {
        self.verify()?;
        if !matches!(expected.phase, Phase::Prepared | Phase::Recoverable) {
            return Err(Error::Changed);
        }
        let mut next = expected.clone();
        next.phase = Phase::Dispatched;
        next.revision = expected.revision.checked_add(1).ok_or(Error::Capacity)?;
        let (bytes, digest) = encode(&next)?;
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| Error::Unavailable)?;
        let native = sqlite::read_records(&tx, &self.id)?;
        let legacy = read_claims(&tx, &self.id)?;
        current(&legacy, expected)?;
        if native
            .iter()
            .any(|record| record.blocks_target() && expected.overlaps_native(&record.binding))
            || legacy
                .iter()
                .any(|claim| claim.id != expected.id && claim.overlaps(&expected.scopes))
        {
            return Err(Error::Occupied);
        }
        if native.iter().filter(|r| r.occupies_worker()).count()
            + legacy
                .iter()
                .filter(|r| r.phase == Phase::Dispatched)
                .count()
            >= 4
        {
            return Err(Error::Capacity);
        }
        let (previous, previous_digest) = encode(expected)?;
        let changed=tx.execute("UPDATE legacy_claims SET revision=?1,value=?2,digest=?3 WHERE id=?4 AND revision=?5 AND value=?6 AND digest=?7",params![next.revision as i64,bytes,digest,expected.id,expected.revision as i64,previous,previous_digest]).map_err(|_|Error::Unavailable)?;
        if changed != 1 {
            return Err(Error::Changed);
        }
        tx.commit().map_err(|_| Error::Unavailable)?;
        self.verify()?;
        Ok(Dispatched { claim: next })
    }
    /// Safe only because this exact claim has no possible-dispatch checkpoint.
    pub fn retire_unsent_legacy(&mut self, expected: &Claim) -> Result<()> {
        if expected.phase != Phase::Prepared {
            return Err(Error::NotDispatched);
        }
        self.remove_legacy(expected)
    }
    /// Only the original worker can supply its single-use dispatch permit.
    /// Neither restart recovery nor a status query can manufacture it.
    pub fn settle_legacy(&mut self, permit: Dispatched) -> Result<()> {
        self.remove_legacy(&permit.claim)
    }
    fn remove_legacy(&mut self, expected: &Claim) -> Result<()> {
        self.verify()?;
        let (bytes, digest) = encode(expected)?;
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| Error::Unavailable)?;
        sqlite::read_records(&tx, &self.id)?;
        current(&read_claims(&tx, &self.id)?, expected)?;
        let changed = tx
            .execute(
                "DELETE FROM legacy_claims WHERE id=?1 AND revision=?2 AND value=?3 AND digest=?4",
                params![expected.id, expected.revision as i64, bytes, digest],
            )
            .map_err(|_| Error::Unavailable)?;
        if changed != 1 {
            return Err(Error::Changed);
        }
        tx.commit().map_err(|_| Error::Unavailable)?;
        self.verify()
    }
}
pub(super) fn current(records: &[Claim], expected: &Claim) -> Result<()> {
    records
        .iter()
        .any(|r| r == expected)
        .then_some(())
        .ok_or(Error::Changed)
}
fn version(conn: &Connection) -> Result<i64> {
    conn.pragma_query_value(None, "user_version", |r| r.get(0))
        .map_err(|_| Error::Unrecognized)
}
pub(super) fn encode(claim: &Claim) -> Result<(String, String)> {
    if !claim.valid() {
        return Err(Error::Unrecognized);
    }
    let bytes = serde_json::to_string(claim).map_err(|_| Error::Unrecognized)?;
    if bytes.len() > MAX_BYTES {
        return Err(Error::Capacity);
    }
    let digest = contracts::hash(b"tunnelde.files.legacy-claim.v1\0", bytes.as_bytes());
    Ok((bytes, digest))
}
pub(in super::super) fn read_claims(conn: &Connection, journal_id: &str) -> Result<Vec<Claim>> {
    match version(conn)? {
        1 => {
            let stale: bool = conn
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name='legacy_claims')",
                    [],
                    |r| r.get(0),
                )
                .map_err(|_| Error::Unrecognized)?;
            if stale {
                return Err(Error::Unrecognized);
            }
            return Ok(Vec::new());
        }
        2 => {}
        _ => return Err(Error::Unrecognized),
    }
    let mut query = conn
        .prepare("SELECT id,revision,value,digest FROM legacy_claims LIMIT 129")
        .map_err(|_| Error::Unrecognized)?;
    let mut rows = query.query([]).map_err(|_| Error::Unavailable)?;
    let mut records = Vec::new();
    while let Some(row) = rows.next().map_err(|_| Error::Unrecognized)? {
        let id: String = row.get(0).map_err(|_| Error::Unrecognized)?;
        let revision: i64 = row.get(1).map_err(|_| Error::Unrecognized)?;
        let bytes = row
            .get_ref(2)
            .map_err(|_| Error::Unrecognized)?
            .as_str()
            .map_err(|_| Error::Unrecognized)?;
        let digest: String = row.get(3).map_err(|_| Error::Unrecognized)?;
        if bytes.len() > MAX_BYTES
            || contracts::hash(b"tunnelde.files.legacy-claim.v1\0", bytes.as_bytes()) != digest
        {
            return Err(Error::Unrecognized);
        }
        let claim: Claim = serde_json::from_str(bytes).map_err(|_| Error::Unrecognized)?;
        if !claim.valid()
            || claim.journal_id != journal_id
            || claim.id != id
            || revision <= 0
            || claim.revision != revision as u64
        {
            return Err(Error::Unrecognized);
        }
        records.push(claim);
    }
    if records.len() > CAPACITY {
        return Err(Error::Capacity);
    }
    Ok(records)
}
pub(in super::super) fn admit_native(
    conn: &Connection,
    journal_id: &str,
    binding: &Binding,
    native: &[Record],
) -> Result<()> {
    let claims = read_claims(conn, journal_id)?;
    if native.len() + claims.len() >= CAPACITY {
        return Err(Error::Capacity);
    }
    if claims.iter().any(|claim| claim.overlaps_native(binding)) {
        return Err(Error::Occupied);
    }
    Ok(())
}
pub(in super::super) fn active(conn: &Connection, journal_id: &str) -> Result<usize> {
    Ok(read_claims(conn, journal_id)?
        .iter()
        .filter(|r| r.phase == Phase::Dispatched)
        .count())
}
