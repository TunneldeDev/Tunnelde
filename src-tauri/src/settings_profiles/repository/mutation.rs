//! Prepared bytes/CAS only. Hashing, validation and serialization happen before
//! taking the final policy + database fences. Selection is read at commit time.
use super::*;

pub(in crate::settings_profiles) struct Prepared {
    pub expected: Captured,
    raw: String,
    nonce: String,
    ids: Vec<String>,
    pub revision: String,
}

pub(in crate::settings_profiles) fn capture(db: &crate::db::Database) -> AppResult<Captured> {
    db.with(|conn| {
        let tx = conn.unchecked_transaction()?;
        let value = super::capture(&tx)?;
        tx.commit()?;
        Ok(value)
    })
}

pub(in crate::settings_profiles) fn prepare(
    expected: Captured,
    profiles: &[SettingsProfile],
) -> AppResult<Prepared> {
    let raw = serde_json::to_string(profiles)?;
    if profiles.len() > MAX_PROFILES || raw.len() > observation::MAX_STORAGE_BYTES {
        return Err(AppError::validation("profiles.storageTooLarge"));
    }
    observation::projection::items(&raw)?;
    let nonce = uuid::Uuid::new_v4().to_string();
    let revision = format!(
        "pc1:{:x}",
        Sha256::digest(serde_json::to_vec(&(&raw, Some(&nonce)))?)
    );
    Ok(Prepared {
        expected,
        raw,
        nonce,
        ids: profiles.iter().map(|p| p.id.clone()).collect(),
        revision,
    })
}

impl Captured {
    /// Caller owns a transaction: the comparison and any subsequent mutation
    /// must share it. Missing rows differ from legacy literal empty collections.
    pub(in crate::settings_profiles) fn compare(&self, conn: &Connection) -> AppResult<()> {
        for (key, expected) in [
            (KEY, self.present.then_some(self.raw.as_str())),
            (observation::REVISION_KEY, self.nonce.as_deref()),
        ] {
            let same: bool = match expected {
                Some(value) => conn.query_row(
                    "SELECT EXISTS(SELECT 1 FROM settings WHERE key=?1 AND typeof(value)='text' AND value=?2)",
                    params![key, value], |row| row.get(0),
                )?,
                None => conn.query_row(
                    "SELECT NOT EXISTS(SELECT 1 FROM settings WHERE key=?1)",
                    [key], |row| row.get(0),
                )?,
            };
            if !same {
                return Err(AppError::validation("profiles.conflict"));
            }
        }
        Ok(())
    }
}

impl Prepared {
    /// Commit cancellation is linearized after the final CAS, before any write.
    /// One transaction covers body, nonce and conditional selection cleanup.
    pub(in crate::settings_profiles) fn persist(
        &self,
        conn: &Connection,
        begin: impl FnOnce() -> AppResult<()>,
    ) -> AppResult<()> {
        let tx = conn.unchecked_transaction()?;
        self.expected.compare(&tx)?;
        let selection = active(&tx)?;
        begin()?;
        for (key, value) in [(KEY, &self.raw), (observation::REVISION_KEY, &self.nonce)] {
            tx.execute("INSERT INTO settings(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at", params![key,value,crate::models::now_ms()])?;
        }
        if selection.is_some_and(|id| !self.ids.contains(&id)) {
            select(&tx, None)?;
        }
        tx.commit()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests;
