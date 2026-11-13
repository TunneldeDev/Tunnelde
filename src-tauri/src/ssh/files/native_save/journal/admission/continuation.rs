//! Only an original worker can durably permit cleanup of its existing claim.
use super::*;
use rusqlite::{params, TransactionBehavior};

impl Journal {
    pub fn park_editor_cleanup(&mut self, permit: Dispatched) -> Result<()> {
        self.park_legacy(permit, Kind::Editor).map(|_| ())
    }

    pub fn park_transfer(&mut self, permit: Dispatched) -> Result<Claim> {
        self.park_legacy(permit, Kind::Transfer)
    }

    fn park_legacy(&mut self, permit: Dispatched, kind: Kind) -> Result<Claim> {
        let expected = permit.claim;
        if expected.kind != kind || expected.phase != Phase::Dispatched {
            return Err(Error::Changed);
        }
        self.verify()?;
        let mut next = expected.clone();
        next.phase = Phase::Recoverable;
        next.revision = next.revision.checked_add(1).ok_or(Error::Capacity)?;
        let (bytes, digest) = persistence::encode(&next)?;
        let (previous, previous_digest) = persistence::encode(&expected)?;
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| Error::Unavailable)?;
        super::super::sqlite::read_records(&tx, &self.id)?;
        persistence::current(&persistence::read_claims(&tx, &self.id)?, &expected)?;
        let changed = tx.execute(
            "UPDATE legacy_claims SET revision=?1,value=?2,digest=?3 WHERE id=?4 AND revision=?5 AND value=?6 AND digest=?7",
            params![next.revision as i64, bytes, digest, expected.id, expected.revision as i64, previous, previous_digest],
        ).map_err(|_| Error::Unavailable)?;
        if changed != 1 {
            return Err(Error::Changed);
        }
        tx.commit().map_err(|_| Error::Unavailable)?;
        self.verify()?;
        Ok(next)
    }
}
