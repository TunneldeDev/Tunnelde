use super::{contracts::*, drafts::Claim};
use crate::{
    db::Database,
    error::{AppError, AppResult},
    services::settings::preferences,
    settings::Settings,
    settings_profiles::{
        self,
        repository::{self, mutation},
        SettingsProfile,
    },
};
use serde_json::Value;

pub(crate) struct Change {
    prepared: mutation::Prepared,
    id: String,
}
impl Change {
    pub(crate) fn persist(
        &self,
        conn: &rusqlite::Connection,
        begin: impl FnOnce() -> AppResult<()>,
    ) -> AppResult<()> {
        self.prepared.persist(conn, begin)
    }
    pub(crate) fn result(&self) -> Changed {
        Changed {
            version: 1,
            id: self.id.clone(),
            revision: self.prepared.revision.clone(),
        }
    }
}
pub(crate) struct Activation {
    captured: repository::Captured,
    pub id: String,
    pub name: String,
    pub revision: String,
    pub values: Value,
}
impl Activation {
    pub(crate) fn compare(&self, conn: &rusqlite::Connection) -> AppResult<()> {
        self.captured.compare(conn)
    }
    pub(crate) fn select(&self, conn: &rusqlite::Connection) -> AppResult<()> {
        repository::select(conn, Some(&self.id))
    }
}
fn source(
    db: &Database,
    expected: &str,
) -> AppResult<(repository::Captured, repository::Snapshot)> {
    revision(expected)?;
    let captured = mutation::capture(db)?;
    let snapshot = captured.clone().decode()?;
    if snapshot.revision != expected {
        return Err(AppError::validation("profiles.conflict"));
    }
    Ok((captured, snapshot))
}
fn index(profiles: &[SettingsProfile], target: &str) -> AppResult<usize> {
    id(target)?;
    profiles
        .iter()
        .position(|p| p.id == target)
        .ok_or_else(|| AppError::NotFound("profiles.notFound".into()))
}
fn name(profiles: &[SettingsProfile], target: Option<&str>, name: &str) -> AppResult<String> {
    let name = settings_profiles::validate_name(name)?;
    if profiles
        .iter()
        .any(|p| Some(p.id.as_str()) != target && p.name.to_lowercase() == name.to_lowercase())
    {
        return Err(AppError::validation("profiles.duplicateName"));
    }
    Ok(name)
}

pub(crate) fn save(
    db: &Database,
    draft: &Claim,
    request: Save,
    check: impl Fn() -> AppResult<()>,
) -> AppResult<Change> {
    revision(&request.revision)?;
    if draft.revision != request.revision {
        return Err(AppError::validation("profiles.conflict"));
    }
    check()?;
    let (captured, mut snapshot) = source(db, &request.revision)?;
    let name = name(&snapshot.profiles, request.id.as_deref(), &request.name)?;
    let (id, baseline) = match request.id {
        Some(target) => {
            let profile = &snapshot.profiles[index(&snapshot.profiles, &target)?];
            let baseline =
                serde_json::from_value(settings_profiles::normalize(profile.settings.clone())?)?;
            (target, baseline)
        }
        None => {
            if snapshot.profiles.len() >= settings_profiles::MAX_PROFILES {
                return Err(AppError::validation("profiles.limit"));
            }
            let mut baseline = Settings::default();
            baseline.sanitize();
            (uuid::Uuid::new_v4().to_string(), baseline)
        }
    };
    check()?;
    let values = serde_json::from_str(&draft.text)
        .map_err(|_| AppError::validation("profiles.content.invalidContent"))?;
    let next = preferences::apply_profile_values(&baseline, values)?;
    // Reuse portable profile policy (including CSS URL restrictions), rather
    // than loosening native imports through a public upload path.
    let settings = settings_profiles::normalize(settings_profiles::portable(&next)?)?;
    let profile = SettingsProfile {
        id: id.clone(),
        name,
        settings,
        updated_at: crate::models::now_ms(),
    };
    if let Some(index) = snapshot.profiles.iter().position(|p| p.id == id) {
        snapshot.profiles[index] = profile;
    } else {
        snapshot.profiles.push(profile);
    }
    check()?;
    let prepared = mutation::prepare(captured, &snapshot.profiles)?;
    check()?;
    Ok(Change { prepared, id })
}
pub(crate) fn rename(
    db: &Database,
    request: Rename,
    check: impl Fn() -> AppResult<()>,
) -> AppResult<Change> {
    check()?;
    let (captured, mut snapshot) = source(db, &request.revision)?;
    let position = index(&snapshot.profiles, &request.id)?;
    let name = name(&snapshot.profiles, Some(&request.id), &request.name)?;
    snapshot.profiles[position].name = name;
    snapshot.profiles[position].updated_at = crate::models::now_ms();
    let prepared = mutation::prepare(captured, &snapshot.profiles)?;
    check()?;
    Ok(Change {
        prepared,
        id: request.id,
    })
}
pub(crate) fn delete(
    db: &Database,
    request: Delete,
    check: impl Fn() -> AppResult<()>,
) -> AppResult<Change> {
    check()?;
    let (captured, mut snapshot) = source(db, &request.revision)?;
    let position = index(&snapshot.profiles, &request.id)?;
    snapshot.profiles.remove(position);
    let prepared = mutation::prepare(captured, &snapshot.profiles)?;
    check()?;
    Ok(Change {
        prepared,
        id: request.id,
    })
}
pub(crate) fn activation(
    db: &Database,
    request: &Activate,
    check: impl Fn() -> AppResult<()>,
) -> AppResult<Activation> {
    check()?;
    let (captured, snapshot) = source(db, &request.revision)?;
    let profile = &snapshot.profiles[index(&snapshot.profiles, &request.id)?];
    let native = serde_json::from_value(settings_profiles::normalize(profile.settings.clone())?)?;
    let values = preferences::profile_values(&native)?;
    check()?;
    Ok(Activation {
        captured,
        id: profile.id.clone(),
        name: profile.name.clone(),
        revision: request.revision.clone(),
        values,
    })
}
