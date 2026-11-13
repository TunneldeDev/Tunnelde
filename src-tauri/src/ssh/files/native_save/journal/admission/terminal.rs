//! Original-worker terminal evidence stays blocking until the app projection syncs.
use super::*;
use rusqlite::{params, TransactionBehavior};
use serde::{Deserialize, Serialize};

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum Outcome {
    Completed { transferred: u64, total: u64 },
    Disposed,
}
impl Outcome {
    pub(crate) fn valid(&self) -> bool {
        match self {
            Self::Completed { transferred, total } => transferred == total,
            Self::Disposed => true,
        }
    }
}

impl Journal {
    /// The caller must seal the original request epoch before consuming its
    /// single-use permit. A status lookup cannot manufacture this transition.
    pub fn complete_transfer(&mut self, permit: Dispatched, outcome: Outcome) -> Result<Claim> {
        if permit.claim.phase != Phase::Dispatched {
            return Err(Error::Changed);
        }
        self.terminal_transfer(&permit.claim, outcome)
    }

    /// Explicit disposal of a known-unsent task. Missing app artifact records
    /// cannot prove that a previously dispatched/parked task has no artifacts.
    pub fn dispose_empty_transfer(&mut self, expected: &Claim) -> Result<Claim> {
        if expected.phase != Phase::Prepared {
            return Err(Error::Changed);
        }
        self.terminal_transfer(expected, Outcome::Disposed)
    }

    fn terminal_transfer(&mut self, expected: &Claim, outcome: Outcome) -> Result<Claim> {
        self.verify()?;
        if expected.kind != Kind::Transfer || expected.transfer_task.is_none() {
            return Err(Error::Changed);
        }
        let mut next = expected.clone();
        next.phase = Phase::Terminal;
        next.terminal = Some(outcome);
        next.revision = next
            .revision
            .checked_add(if expected.phase == Phase::Dispatched {
                1
            } else {
                2
            })
            .ok_or(Error::Capacity)?;
        let (bytes, digest) = persistence::encode(&next)?;
        let (previous, previous_digest) = persistence::encode(expected)?;
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| Error::Unavailable)?;
        super::super::sqlite::read_records(&tx, &self.id)?;
        persistence::current(&persistence::read_claims(&tx, &self.id)?, expected)?;
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

    /// Only after the exact terminal projection has synchronously committed.
    /// A crash/lost delivery leaves either a terminal claim or a synced row,
    /// neither of which can authorize replay of the original mutation.
    pub fn retire_transfer_terminal(&mut self, expected: &Claim) -> Result<()> {
        if expected.phase != Phase::Terminal || expected.terminal.is_none() {
            return Err(Error::Changed);
        }
        self.remove_legacy(expected)
    }
}
