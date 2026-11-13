//! Add exact generated paths to a transfer's original durable reservation.
use super::*;
use crate::services::files::admission::Path;
use rusqlite::{params, TransactionBehavior};

impl Dispatched {
    /// Install the returned checkpoint only into its original live permit.
    pub(in super::super::super) fn adopt_transfer_extension(&mut self, next: Claim) -> Result<()> {
        let original = &self.claim;
        if original.kind != Kind::Transfer
            || original.phase != Phase::Dispatched
            || next.kind != original.kind
            || next.phase != original.phase
            || next.id != original.id
            || next.journal_id != original.journal_id
            || next.owner != original.owner
            || next.transfer_roots != original.transfer_roots
            || next.transfer_task != original.transfer_task
            || !next.valid()
            || !(next.revision == original.revision
                || original.revision.checked_add(2) == Some(next.revision))
            || next.scopes.len() != original.scopes.len()
            || !original.scopes.iter().zip(&next.scopes).all(|(old, new)| {
                old.destination == new.destination
                    && old.platform == new.platform
                    && new.paths.starts_with(&old.paths)
            })
            || (next.revision == original.revision && next != *original)
        {
            return Err(Error::Changed);
        }
        self.claim = next;
        Ok(())
    }
}

impl Journal {
    /// This only extends reservation coverage. It never mints a dispatch or
    /// settlement permit, resumes an unknown worker, or authorizes network I/O.
    pub fn extend_transfer(&mut self, expected: &Claim, additional: Vec<Scope>) -> Result<Claim> {
        self.verify()?;
        if expected.kind != Kind::Transfer
            || expected.phase != Phase::Dispatched
            || additional.is_empty()
            || additional.len() > 4
        {
            return Err(Error::Changed);
        }
        let mut next = expected.clone();
        for added in additional {
            if !added.valid() {
                return Err(Error::Unrecognized);
            }
            // A generated path cannot quietly change the authenticated endpoint
            // or platform captured by the original task.
            let scope = next
                .scopes
                .iter_mut()
                .find(|scope| {
                    scope.destination == added.destination && scope.platform == added.platform
                })
                .ok_or(Error::Changed)?;
            for path in added.paths {
                let platform = scope.platform().ok_or(Error::Unrecognized)?;
                let requested = Path::new(&path, platform).ok_or(Error::Unrecognized)?;
                if !scope.paths.iter().any(|existing| {
                    Path::new(existing, platform)
                        .is_some_and(|reserved| reserved.contains(&requested))
                }) {
                    scope.paths.push(path);
                }
            }
        }
        if next.scopes != expected.scopes {
            // Dispatched revisions remain even; no intermediate resumable phase.
            next.revision = next.revision.checked_add(2).ok_or(Error::Capacity)?;
        }
        let (bytes, digest) = persistence::encode(&next)?;
        let (previous, previous_digest) = persistence::encode(expected)?;
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| Error::Unavailable)?;
        let native = super::super::sqlite::read_records(&tx, &self.id)?;
        let legacy = persistence::read_claims(&tx, &self.id)?;
        persistence::current(&legacy, expected)?;
        if super::super::setup::read(&tx, &self.id)?
            .iter()
            .any(|setup| setup.plan.conflicts(&next.scopes))
            || native
                .iter()
                .any(|record| record.blocks_target() && next.overlaps_native(&record.binding))
            || legacy
                .iter()
                .any(|claim| claim.id != expected.id && claim.overlaps(&next.scopes))
        {
            return Err(Error::Occupied);
        }
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
