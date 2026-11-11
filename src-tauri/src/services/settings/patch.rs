//! Legacy merge semantics, separate from the future versioned public field schema.
use crate::{
    error::{AppError, AppResult},
    settings::Settings,
};
use serde_json::Value;

// Empty maps deliberately clear these settings. In particular, deep-merging an
// empty provider selection would undo the user's recovery to the built-in UI.
const REPLACED_KEYS: &[&str] = &[
    "colors",
    "keyboardShortcuts",
    "shortcutRules",
    "network",
    "uiProviders",
];

pub(super) fn apply(previous: &Settings, patch: Value) -> AppResult<Settings> {
    if !patch.is_object() {
        return Err(AppError::validation("settings.invalid"));
    }
    let mut base = serde_json::to_value(previous)?;
    let replacements: Vec<_> = REPLACED_KEYS
        .iter()
        .filter_map(|key| patch.get(*key).map(|value| (*key, value.clone())))
        .collect();
    merge(&mut base, patch);
    for (key, value) in replacements {
        base[key] = value;
    }
    let mut next: Settings = serde_json::from_value(base)
        .map_err(|error| AppError::validation(format!("settings.invalid: {error}")))?;
    next.sanitize();
    next.network.validate()?;
    crate::update::validate_preferences(&next)?;
    Ok(next)
}

fn merge(base: &mut Value, patch: Value) {
    match (base, patch) {
        (Value::Object(base), Value::Object(patch)) => {
            for (key, value) in patch {
                match base.get_mut(&key) {
                    Some(slot) if slot.is_object() && value.is_object() => merge(slot, value),
                    _ => {
                        base.insert(key, value);
                    }
                }
            }
        }
        (slot, value) => *slot = value,
    }
}

#[cfg(test)]
#[path = "patch_tests.rs"]
mod tests;
