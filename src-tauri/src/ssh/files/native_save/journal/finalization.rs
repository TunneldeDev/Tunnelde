//! Local retirement precedes credential deletion; unknown writes cannot be forgotten.
use super::{Error, Journal, Record, Result, Stage};
use rusqlite::{params, TransactionBehavior};

impl Journal {
    /// The actual credential writer owns SQLite's cross-process write lock.
    /// Retirement cannot remove its durable reservation before setup finishes.
    /// A crash rolls back readiness, leaving the reservation and any token for retry.
    pub fn provision(
        &mut self,
        expected: &Record,
        setup: impl FnOnce() -> Result<()>,
    ) -> Result<Record> {
        self.verify()?;
        if expected.stage != Stage::Reserved {
            return Err(Error::Changed);
        }
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| Error::Unavailable)?;
        if !super::sqlite::read_records(&tx, &self.id)?
            .iter()
            .any(|record| record == expected)
        {
            return Err(Error::Changed);
        }
        setup()?;
        let mut next = expected.clone();
        next.stage = Stage::Ready;
        next.revision = expected.revision.checked_add(1).ok_or(Error::Capacity)?;
        let (bytes, digest) = super::sqlite::encode(&next)?;
        let (previous, previous_digest) = super::sqlite::encode(expected)?;
        let changed = tx.execute(
            "UPDATE records SET revision=?1,value=?2,digest=?3 WHERE id=?4 AND revision=?5 AND value=?6 AND digest=?7",
            params![next.revision as i64, bytes, digest, expected.binding.operation_id, expected.revision as i64, previous, previous_digest],
        ).map_err(|_| Error::Unavailable)?;
        if changed != 1 {
            return Err(Error::Changed);
        }
        tx.commit().map_err(|_| Error::Unavailable)?;
        self.verify()?;
        Ok(next)
    }

    pub fn retire(&mut self, expected: &Record) -> Result<Record> {
        self.current(expected)?;
        if expected.disposable() {
            return Ok(expected.clone());
        }
        let mut next = expected.clone();
        next.stage = match expected.stage {
            Stage::Reserved | Stage::Ready => Stage::Abandoned,
            Stage::Dispatched if expected.released() => Stage::Retired,
            _ => return Err(Error::Changed),
        };
        next.revision = expected.revision.checked_add(1).ok_or(Error::Capacity)?;
        self.replace(expected, &next)
    }
    pub fn forget_retired(
        &mut self,
        expected: &Record,
        cleanup: impl FnOnce() -> Result<()>,
    ) -> Result<()> {
        self.verify()?;
        if !expected.disposable() {
            return Err(Error::Changed);
        }
        let (bytes, digest) = super::sqlite::encode(expected)?;
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| Error::Unavailable)?;
        if !super::sqlite::read_records(&tx, &self.id)?
            .iter()
            .any(|record| record == expected)
        {
            return Err(Error::Changed);
        }
        // Recheck under the same cross-process write lock used by provisioning.
        // A late second finalizer must not delete a later credential after its
        // original record has already been removed by the first finalizer.
        cleanup()?;
        let changed = tx
            .execute(
                "DELETE FROM records WHERE id=?1 AND revision=?2 AND value=?3 AND digest=?4",
                params![
                    expected.binding.operation_id,
                    expected.revision as i64,
                    bytes,
                    digest
                ],
            )
            .map_err(|_| Error::Unavailable)?;
        if changed != 1 {
            return Err(Error::Changed);
        }
        tx.commit().map_err(|_| Error::Unavailable)?;
        self.verify()
    }
}
