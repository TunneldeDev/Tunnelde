//! Explicit opt-in schema extension; opening an old journal never installs anything.
mod model;
mod persistence;
use super::{Error, Journal, Owner, Result};
use crate::ssh::files::native_save::contracts::authority::Authority;
#[cfg(test)]
pub(in crate::ssh::files::native_save) use model::Package;
pub(in crate::ssh::files::native_save) use model::{Plan, Record, Stage};
pub(in super::super) use persistence::read;
use rusqlite::{params, TransactionBehavior};
#[cfg(test)]
mod tests;

/// The original worker alone may cross the first remote mutation boundary.
/// Reopening a dispatched setup never reconstructs this non-cloneable permit.
pub(in crate::ssh::files::native_save) struct Dispatched {
    record: Record,
}
impl Dispatched {
    pub fn record(&self) -> &Record {
        &self.record
    }
}
impl Journal {
    pub fn setups(&self) -> Result<Vec<Record>> {
        self.verify()?;
        read(&self.conn, &self.id)
    }
    pub fn enable_setups(&mut self) -> Result<()> {
        self.enable_admission()?;
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| Error::Unavailable)?;
        super::sqlite::read_records(&tx, &self.id)?;
        let version: i64 = tx
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .map_err(|_| Error::Unrecognized)?;
        match version {
            2 => tx.execute_batch("CREATE TABLE native_setups(id TEXT PRIMARY KEY, revision INTEGER NOT NULL, value TEXT NOT NULL, digest TEXT NOT NULL); PRAGMA user_version=3;").map_err(|_| Error::Unavailable)?,
            3 => { read(&tx, &self.id)?; }
            _ => return Err(Error::Unrecognized),
        }
        tx.commit().map_err(|_| Error::Unavailable)?;
        self.schema_version = 3;
        self.verify()
    }
    /// Call only after consent. No remote mutation is permitted by a reservation.
    pub fn reserve_setup(&mut self, owner: Owner, plan: Plan) -> Result<Record> {
        self.verify()?;
        let record = Record {
            id: uuid::Uuid::new_v4().to_string(),
            journal_id: self.id.clone(),
            revision: 1,
            owner,
            plan,
            stage: Stage::Reserved,
            authority: None,
        };
        let (bytes, digest) = persistence::encode(&record)?;
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| Error::Unavailable)?;
        let version: i64 = tx
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .map_err(|_| Error::Unrecognized)?;
        if version != 3 {
            return Err(Error::Unrecognized);
        }
        let setups = read(&tx, &self.id)?;
        if setups.len() >= persistence::CAPACITY {
            return Err(Error::Capacity);
        }
        let native = super::sqlite::read_records(&tx, &self.id)?;
        let legacy = super::admission::persistence::read_claims(&tx, &self.id)?;
        if setups.iter().any(|old| old.plan.overlaps(&record.plan))
            || legacy
                .iter()
                .any(|claim| record.plan.conflicts(&claim.scopes))
            || native.iter().any(|old| {
                old.blocks_target()
                    && record.plan.same_host(&old.binding.destination)
                    && (record.plan.protects(&old.binding.target_path())
                        || record.plan.protects(&old.binding.selection.directory)
                        || record.plan.protects(&old.binding.selection.executable))
            })
        {
            return Err(Error::Occupied);
        }
        tx.execute(
            "INSERT INTO native_setups VALUES(?1,?2,?3,?4)",
            params![record.id, record.revision as i64, bytes, digest],
        )
        .map_err(|_| Error::Unavailable)?;
        tx.commit().map_err(|_| Error::Unavailable)?;
        self.verify()?;
        Ok(record)
    }
    pub fn dispatch_setup(&mut self, expected: &Record) -> Result<Dispatched> {
        if expected.stage != Stage::Reserved {
            return Err(Error::Changed);
        }
        let mut next = expected.clone();
        next.stage = Stage::Dispatched;
        next.revision = 2;
        self.replace_setup(expected, &next)?;
        Ok(Dispatched { record: next })
    }
    /// A response may settle only the exact original attempt, never a replacement.
    pub fn complete_setup(&mut self, permit: Dispatched, authority: Authority) -> Result<Record> {
        let expected = permit.record;
        if !expected.plan.matches(&authority) {
            return Err(Error::Changed);
        }
        let mut next = expected.clone();
        next.stage = Stage::Ready;
        next.revision = 3;
        next.authority = Some(authority);
        self.replace_setup(&expected, &next)?;
        Ok(next)
    }
    /// Only definitely unsent intent can disappear without remote inspection.
    pub fn discard_setup(&mut self, expected: &Record) -> Result<()> {
        self.verify()?;
        if expected.stage != Stage::Reserved {
            return Err(Error::NotDispatched);
        }
        let (bytes, digest) = persistence::encode(expected)?;
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| Error::Unavailable)?;
        persistence::current(&tx, &self.id, expected)?;
        let changed = tx
            .execute(
                "DELETE FROM native_setups WHERE id=?1 AND revision=?2 AND value=?3 AND digest=?4",
                params![expected.id, expected.revision as i64, bytes, digest],
            )
            .map_err(|_| Error::Unavailable)?;
        if changed != 1 {
            return Err(Error::Changed);
        }
        tx.commit().map_err(|_| Error::Unavailable)?;
        self.verify()
    }
    fn replace_setup(&mut self, expected: &Record, next: &Record) -> Result<()> {
        self.verify()?;
        if expected.id != next.id
            || expected.journal_id != next.journal_id
            || expected.owner != next.owner
            || expected.plan != next.plan
            || expected.revision.checked_add(1) != Some(next.revision)
        {
            return Err(Error::Changed);
        }
        let (bytes, digest) = persistence::encode(next)?;
        let (previous, previous_digest) = persistence::encode(expected)?;
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| Error::Unavailable)?;
        persistence::current(&tx, &self.id, expected)?;
        let changed = tx.execute("UPDATE native_setups SET revision=?1,value=?2,digest=?3 WHERE id=?4 AND revision=?5 AND value=?6 AND digest=?7", params![next.revision as i64, bytes, digest, expected.id, expected.revision as i64, previous, previous_digest]).map_err(|_| Error::Unavailable)?;
        if changed != 1 {
            return Err(Error::Changed);
        }
        tx.commit().map_err(|_| Error::Unavailable)?;
        self.verify()
    }
}
