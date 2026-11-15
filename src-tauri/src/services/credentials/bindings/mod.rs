//! Native credential metadata. Callers own host/profile/review authorization.
//! No operation here performs OS access. Owner invalidation must share the
//! transaction that deletes/recreates a host or changes a proxy incarnation.
use crate::error::{AppError, AppResult};
use rusqlite::{params, Connection, OptionalExtension};
use uuid::Uuid;

mod cleanup;
mod mutations;
#[cfg(test)]
mod tests;

#[derive(Clone, PartialEq, Eq)]
pub(super) struct Owner {
    kind: &'static str,
    id: String,
}

impl Owner {
    pub(super) fn host(id: &str) -> AppResult<Self> {
        Self::new("host", id)
    }

    pub(super) fn proxy(id: &str) -> AppResult<Self> {
        Self::new("proxy", id)
    }

    fn new(kind: &'static str, id: &str) -> AppResult<Self> {
        // Also validate metadata reconstructed by cleanup, not only new callers.
        let reserved_host_key = kind == "host"
            && ["proxy:", "plugin:", "tunnelde."]
                .iter()
                .any(|prefix| id.starts_with(prefix));
        if !matches!(kind, "host" | "proxy")
            || reserved_host_key
            || id.is_empty()
            || id.len() > 256
            || id.chars().any(char::is_control)
        {
            return Err(corrupt());
        }
        Ok(Self {
            kind,
            id: id.into(),
        })
    }
}

/// A legacy source is explicit after the first authority renewal. A tombstone
/// never grants fallback. Configuration incarnation is separate from the
/// password revision so saving a password does not invalidate a prompt review.
#[derive(Clone, PartialEq, Eq)]
pub(super) struct Binding {
    owner: Owner,
    revision: Option<Uuid>,
    incarnation: Option<Uuid>,
    item: Option<Uuid>,
    legacy: bool,
}

#[derive(Clone, PartialEq, Eq)]
pub(super) enum Physical {
    Immutable(Uuid),
    Legacy(Owner),
}

impl Physical {
    pub(super) fn key(&self) -> String {
        match self {
            Self::Immutable(id) => format!("tunnelde.credential.v1:{id}"),
            Self::Legacy(owner) if owner.kind == "proxy" => format!("proxy:{}", owner.id),
            Self::Legacy(owner) => owner.id.clone(),
        }
    }
}

impl Binding {
    pub(super) fn physical(&self) -> Option<Physical> {
        match (self.legacy, self.item) {
            (_, Some(id)) => Some(Physical::Immutable(id)),
            (true, None) => Some(Physical::Legacy(self.owner.clone())),
            (false, None) => None,
        }
    }

    pub(super) fn incarnation(&self) -> Option<Uuid> {
        self.incarnation
    }
}

fn corrupt() -> AppError {
    AppError::internal("credentials.invalidMetadata")
}

fn stale() -> AppError {
    AppError::validation("credentials.changed")
}

fn transaction_required(conn: &Connection) -> AppResult<()> {
    if conn.is_autocommit() {
        return Err(AppError::internal("credentials.transactionRequired"));
    }
    Ok(())
}

fn parse(value: &str) -> AppResult<Uuid> {
    let id = Uuid::parse_str(value).map_err(|_| corrupt())?;
    if id.hyphenated().to_string() != value || id.get_version_num() != 4 {
        return Err(corrupt());
    }
    Ok(id)
}

fn authority(value: &str) -> AppResult<()> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        return Err(corrupt());
    }
    Ok(())
}

pub(super) fn capture(conn: &Connection, owner: &Owner) -> AppResult<Binding> {
    let row = conn
        .query_row(
            "SELECT revision, item, incarnation, legacy FROM credential_bindings WHERE kind=?1 AND owner=?2",
            params![owner.kind, owner.id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?, row.get::<_, i64>(3)?)),
        )
        .optional()?;
    let (revision, item, incarnation, legacy) = match row {
        Some((revision, item, incarnation, legacy)) => (
            Some(parse(&revision)?),
            item.map(|v| parse(&v)).transpose()?,
            incarnation.map(|v| parse(&v)).transpose()?,
            match legacy {
                0 => false,
                1 => true,
                _ => return Err(corrupt()),
            },
        ),
        None => (None, None, None, true),
    };
    if item.is_some() && legacy {
        return Err(corrupt());
    }
    // Do not authenticate using a malformed pointer or an operation whose
    // publication has not committed. Never degrade corruption to legacy.
    if let Some(item) = item {
        let published: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM credential_operations
             WHERE id=?1 AND kind=?2 AND owner=?3 AND phase='published')",
            params![item.to_string(), owner.kind, owner.id],
            |r| r.get(0),
        )?;
        if !published {
            return Err(corrupt());
        }
    }
    Ok(Binding {
        owner: owner.clone(),
        revision,
        incarnation,
        item,
        legacy,
    })
}

pub(super) fn verify(conn: &Connection, expected: &Binding) -> AppResult<()> {
    if capture(conn, &expected.owner)? != *expected {
        return Err(stale());
    }
    Ok(())
}

fn write_binding(
    conn: &Connection,
    owner: &Owner,
    physical: Option<Physical>,
    incarnation: Option<Uuid>,
) -> AppResult<()> {
    transaction_required(conn)?;
    let (item, legacy) = match physical {
        Some(Physical::Immutable(item)) => (Some(item.to_string()), false),
        Some(Physical::Legacy(actual)) if actual == *owner => (None, true),
        Some(Physical::Legacy(_)) => return Err(corrupt()),
        None => (None, false),
    };
    conn.execute(
        "INSERT INTO credential_bindings (kind,owner,revision,item,incarnation,legacy) VALUES (?1,?2,?3,?4,?5,?6)
         ON CONFLICT(kind,owner) DO UPDATE SET revision=excluded.revision,item=excluded.item,
            incarnation=excluded.incarnation,legacy=excluded.legacy",
        params![
            owner.kind,
            owner.id,
            Uuid::new_v4().to_string(),
            item,
            incarnation.map(|id| id.to_string()),
            legacy,
        ],
    )?;
    Ok(())
}

/// Use inside the transaction that creates/deletes/reincarnates the owner.
/// Keep this tombstone even after cleanup: dropping it revives legacy access.
pub(super) fn invalidate(conn: &Connection, owner: &Owner) -> AppResult<()> {
    transaction_required(conn)?;
    let previous = capture(conn, owner)?;
    write_binding(conn, owner, None, Some(Uuid::new_v4()))?;
    cleanup::queue(conn, &previous)?;
    Ok(())
}

/// Host/route/profile edits renew request authority without implicitly losing
/// the user's existing credential. Deletion/recreation uses invalidate instead.
pub(super) fn renew(conn: &Connection, owner: &Owner) -> AppResult<()> {
    transaction_required(conn)?;
    let previous = capture(conn, owner)?;
    write_binding(conn, owner, previous.physical(), Some(Uuid::new_v4()))
}

/// Explicit forget changes the credential binding, not connection identity.
pub(super) fn forget(conn: &Connection, expected: &Binding) -> AppResult<()> {
    transaction_required(conn)?;
    verify(conn, expected)?;
    write_binding(conn, &expected.owner, None, expected.incarnation)?;
    cleanup::queue(conn, expected)
}

#[cfg(test)]
use cleanup::Retirement;
pub(super) use cleanup::{claim, complete, recover};
#[cfg(test)]
use mutations::Intent;
pub(super) use mutations::{abandon, begin, publish, written};
