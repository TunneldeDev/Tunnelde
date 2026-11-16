use super::*;
use crate::{db::Database, services::operations::Cancellation};

pub(super) fn load(conn: &Connection) -> AppResult<Vec<SettingsProfile>> {
    Ok(repository::read(conn)?.profiles)
}

pub(super) fn save(conn: &Connection, profiles: &[SettingsProfile]) -> AppResult<()> {
    repository::save(conn, profiles)
}

#[cfg(test)]
pub(super) fn upsert(
    conn: &Connection,
    id: Option<String>,
    name: String,
    settings: Value,
) -> AppResult<Vec<SettingsProfile>> {
    upsert_guarded(conn, id, name, settings, || Ok(()))
}

fn upsert_guarded(
    conn: &Connection,
    id: Option<String>,
    name: String,
    settings: Value,
    admit: impl FnOnce() -> AppResult<()>,
) -> AppResult<Vec<SettingsProfile>> {
    let name = validate_name(&name)?;
    let settings = normalize(settings)?;
    let mut profiles = load(conn)?;
    if profiles.iter().any(|profile| {
        Some(&profile.id) != id.as_ref() && profile.name.to_lowercase() == name.to_lowercase()
    }) {
        return Err(AppError::validation("profiles.duplicateName"));
    }
    if let Some(id) = id {
        let profile = profiles
            .iter_mut()
            .find(|profile| profile.id == id)
            .ok_or_else(|| AppError::NotFound("profiles.notFound".into()))?;
        profile.name = name;
        profile.settings = settings;
        profile.updated_at = now_ms();
    } else {
        if profiles.len() >= MAX_PROFILES {
            return Err(AppError::validation("profiles.limit"));
        }
        profiles.push(SettingsProfile {
            id: uuid::Uuid::new_v4().to_string(),
            name,
            settings,
            updated_at: now_ms(),
        });
    }
    admit()?;
    save(conn, &profiles)?;
    Ok(profiles)
}

pub(super) fn read(db: &Database, cancellation: &Cancellation) -> AppResult<Vec<SettingsProfile>> {
    db.with(|conn| {
        cancellation.check()?;
        let profiles = load(conn)?;
        cancellation.check()?;
        Ok(profiles)
    })
}

pub(super) enum Change {
    Save {
        id: Option<String>,
        name: String,
        settings: Value,
    },
    Delete {
        id: String,
    },
}

pub(super) fn mutate(
    db: &Database,
    cancellation: &Cancellation,
    change: Change,
) -> AppResult<Vec<SettingsProfile>> {
    cancellation.check()?;
    db.with(|conn| {
        cancellation.check()?;
        // This native operation keeps its historical unconditional semantics.
        // Repository persistence still owns the body/revision/selection transaction.
        match change {
            Change::Save { id, name, settings } => {
                upsert_guarded(conn, id, name, settings, || cancellation.commit())
            }
            Change::Delete { id } => {
                let mut profiles = load(conn)?;
                let before = profiles.len();
                profiles.retain(|profile| profile.id != id);
                if profiles.len() == before {
                    return Err(AppError::NotFound("profiles.notFound".into()));
                }
                cancellation.commit()?;
                save(conn, &profiles)?;
                Ok(profiles)
            }
        }
    })
}

#[cfg(test)]
mod tests;
