//! Explicit public-to-private adapter. Each supplied field replaces its value.
use super::{invalid, mapping::GROUPS, projection, schema};
use crate::{error::AppResult, settings::Settings};
use serde_json::Value;

pub(super) fn apply(previous: &Settings, changes: Value) -> AppResult<Settings> {
    if serde_json::to_vec(&changes)?.len() > 256 * 1024 {
        return Err(invalid("changes"));
    }
    apply_fields(previous, changes)
}

/// A saved profile is a complete public value, not a partial preference patch.
/// Its domain owns body/collection bounds; keep the partial RPC's 256KiB limit.
pub(super) fn full(previous: &Settings, values: Value) -> AppResult<Settings> {
    let fields = values.as_object().ok_or_else(|| invalid("values"))?;
    if fields.len() != GROUPS.len() {
        return Err(invalid("values"));
    }
    for group in GROUPS {
        schema::check(&schema::groups()[group.id], &values[group.id], group.id)?;
    }
    apply_fields(previous, values)
}

fn apply_fields(previous: &Settings, changes: Value) -> AppResult<Settings> {
    let fields = changes.as_object().ok_or_else(|| invalid("changes"))?;
    let mut internal = serde_json::to_value(previous)?;
    let mut expected = projection::values(previous)?;
    for (id, changes) in fields {
        let group = GROUPS
            .iter()
            .find(|group| group.id == id)
            .ok_or_else(|| invalid("changes"))?;
        let changes = changes.as_object().ok_or_else(|| invalid(id))?;
        for (key, value) in changes {
            let &(_, private) = group
                .fields
                .iter()
                .find(|(public, _)| public == key)
                .ok_or_else(|| invalid(id))?;
            schema::check(
                &schema::groups()[id]["properties"][key],
                value,
                &format!("{id}.{key}"),
            )?;
            expected[id][key] = value.clone();
            if let Some((parent, field)) = private.split_once('.') {
                internal[parent][field] = value.clone();
            } else {
                internal[private] = value.clone();
            }
        }
    }
    let mut next: Settings = serde_json::from_value(internal).map_err(|_| invalid("changes"))?;
    next.sanitize();
    let normalized = projection::values(&next)?;
    // Sanitizing old/native preferences remains compatible, but the new public
    // API never acknowledges silently discarded, clamped or truncated values.
    for group in GROUPS {
        for &(field, _) in group.fields {
            if normalized[group.id][field] != expected[group.id][field] {
                return Err(invalid(&format!("{}.{}", group.id, field)));
            }
        }
    }
    next.network.validate().map_err(|_| invalid("network"))?;
    crate::update::validate_preferences(&next).map_err(|_| invalid("updates"))?;
    Ok(next)
}
