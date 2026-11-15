//! Immutable OS items are acquired outside every authority/database guard.
//! The native ingress owns original host/profile/review checks; this service
//! owns credential CAS, cancellation admission and durable cleanup obligations.
use super::super::operations::Cancellation;
use super::bindings::{self, Binding, Owner};
use crate::db::Database;
use crate::error::{AppError, AppResult};
use rusqlite::Connection;
use sha2::{Digest, Sha256};
use uuid::Uuid;

mod mutations;
#[cfg(test)]
mod tests;

/// Only the OS adapter sees secret values. A mock implements this same boundary
/// for controlled failures and concurrent service tests; it is not OS acceptance.
pub(super) trait Platform: Send + Sync {
    fn read(&self, item: &str) -> AppResult<Option<String>>;
    fn write(&self, item: &str, secret: &str) -> AppResult<()>;
    fn delete(&self, item: &str) -> AppResult<()>;
}

impl Platform for crate::vault::Vault {
    fn read(&self, item: &str) -> AppResult<Option<String>> {
        self.load(item)
    }
    fn write(&self, item: &str, secret: &str) -> AppResult<()> {
        self.save(item, secret)
    }
    fn delete(&self, item: &str) -> AppResult<()> {
        self.forget(item)
    }
}

/// An opaque native identity, not a WebView-supplied authorization token.
/// No plaintext endpoints, credentials or arbitrary string payload in journal.
#[derive(PartialEq, Eq)]
pub(super) struct Stamp(String);
impl Stamp {
    pub(super) fn capture(identity: &[u8]) -> Self {
        let mut digest = Sha256::new();
        digest.update(b"tunnelde.credential.authority.v1\0");
        digest.update((identity.len() as u64).to_le_bytes());
        digest.update(identity);
        Self(format!("{:x}", digest.finalize()))
    }
}

pub(super) struct Service<'a, P> {
    db: &'a Database,
    platform: &'a P,
    run: Uuid,
}

/// Configuration checks may not perform OS access. `before` runs without a DB
/// guard (e.g. dynamic-source policy); `check` runs within the original DB guard.
/// Both repeat at actual worker admission and before result publication/use.
pub(super) struct Request<'a, Before, Check> {
    db: &'a Database,
    run: Uuid,
    binding: Binding,
    stamp: Stamp,
    before: Before,
    check: Check,
}

impl<'a, P: Platform> Service<'a, P> {
    pub(super) fn new(db: &'a Database, platform: &'a P, run: Uuid) -> AppResult<Self> {
        if run.get_version_num() != 4 {
            return Err(AppError::internal("credentials.invalidMetadata"));
        }
        Ok(Self { db, platform, run })
    }

    pub(super) fn capture<Before, Check>(
        &self,
        owner: Owner,
        before: Before,
        check: Check,
    ) -> AppResult<Request<'a, Before, Check>>
    where
        Before: Fn() -> AppResult<()>,
        Check: Fn(&Connection) -> AppResult<Stamp>,
    {
        before()?;
        let (stamp, binding) = self
            .db
            .with(|conn| Ok((check(conn)?, bindings::capture(conn, &owner)?)))?;
        Ok(Request {
            db: self.db,
            run: self.run,
            binding,
            stamp,
            before,
            check,
        })
    }

    fn own<Before, Check>(&self, request: &Request<'_, Before, Check>) -> AppResult<()> {
        if !std::ptr::eq(self.db, request.db) || self.run != request.run {
            return Err(AppError::validation("credentials.changed"));
        }
        Ok(())
    }

    pub(super) fn read<Before, Check>(
        &self,
        request: &Request<'_, Before, Check>,
        job: &Cancellation,
    ) -> AppResult<Option<String>>
    where
        Before: Fn() -> AppResult<()>,
        Check: Fn(&Connection) -> AppResult<Stamp>,
    {
        self.own(request)?;
        let physical = request.with(|conn| {
            bindings::verify(conn, &request.binding)?;
            job.commit()?;
            Ok(request.binding.physical())
        })?;
        let value = match physical {
            Some(physical) => self.platform.read(&physical.key())?,
            None => None,
        };
        request.with(|conn| bindings::verify(conn, &request.binding))?;
        Ok(value)
    }

    /// One claimed OS deletion per bounded worker. An error retains the same
    /// claim and item for explicit/startup recovery; it does not spin or requeue.
    pub(super) fn retire_one(&self, job: &Cancellation) -> AppResult<bool> {
        let retirement = self.transaction(|conn| {
            let retirement = bindings::claim(conn, self.run)?;
            if retirement.is_some() {
                job.commit()?;
            }
            Ok(retirement)
        })?;
        let Some(retirement) = retirement else {
            return Ok(false);
        };
        self.platform.delete(&retirement.physical().key())?;
        self.transaction(|conn| bindings::complete(conn, &retirement))?;
        Ok(true)
    }

    /// Call only at startup after exclusive database/storage ownership, before
    /// starting workers. No OS IO, logical save replay or live-operation timeout.
    pub(super) fn recover_startup_page(&self) -> AppResult<usize> {
        self.transaction(|conn| bindings::recover(conn, self.run, 32))
    }

    fn transaction<T>(&self, effect: impl FnOnce(&Connection) -> AppResult<T>) -> AppResult<T> {
        self.db.with(|conn| transaction(conn, effect))
    }
}

impl<Before, Check> Request<'_, Before, Check>
where
    Before: Fn() -> AppResult<()>,
    Check: Fn(&Connection) -> AppResult<Stamp>,
{
    fn with<T>(&self, effect: impl FnOnce(&Connection) -> AppResult<T>) -> AppResult<T> {
        (self.before)()?;
        self.db.with(|conn| {
            if (self.check)(conn)? != self.stamp {
                return Err(AppError::validation("credentials.changed"));
            }
            effect(conn)
        })
    }
}

fn transaction<T>(
    conn: &Connection,
    effect: impl FnOnce(&Connection) -> AppResult<T>,
) -> AppResult<T> {
    let transaction = conn.unchecked_transaction()?;
    let value = effect(&transaction)?;
    transaction.commit()?;
    Ok(value)
}
