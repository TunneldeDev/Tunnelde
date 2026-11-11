//! Bounded, value-derived latest-state reads of this plugin's existing JSON map.
pub(super) mod contracts;
use crate::error::{AppError, AppResult};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

const MAX_DEPTH: usize = 64;
const MAX_RESPONSE: usize = super::MAX_STORAGE + 1024;
fn invalid() -> AppError {
    AppError::validation("plugin.api.invalidStorage")
}

// Explicit sorting makes revisions independent of serde_json map feature selection
// and a legacy writer's object-key order. Arrays retain their semantic order.
fn canonical(value: Value, depth: usize) -> AppResult<Value> {
    if depth > MAX_DEPTH {
        return Err(invalid());
    }
    match value {
        Value::Number(number) => {
            let value = number.as_f64().ok_or_else(invalid)?;
            if !value.is_finite() || (value.fract() == 0.0 && value.abs() > 9_007_199_254_740_991.0)
            {
                return Err(invalid());
            }
            Ok(Value::Number(number))
        }
        Value::Array(items) => items
            .into_iter()
            .map(|value| canonical(value, depth + 1))
            .collect(),
        Value::Object(items) => {
            let sorted: std::collections::BTreeMap<_, _> = items.into_iter().collect();
            sorted
                .into_iter()
                .map(|(key, value)| Ok((key, canonical(value, depth + 1)?)))
                .collect()
        }
        other => Ok(other),
    }
}

pub(super) fn project(
    id: &str,
    values: Map<String, Value>,
    request: contracts::Observe,
) -> AppResult<Value> {
    if !values.keys().all(|key| super::valid_storage_key(key)) {
        return Err(invalid());
    }
    let Value::Object(values) = canonical(Value::Object(values), 0)? else {
        return Err(invalid());
    };
    let encoded = serde_json::to_vec(&values)?;
    if encoded.len() > super::MAX_STORAGE {
        return Err(AppError::validation("plugin.api.storageTooLarge"));
    }
    let mut digest = Sha256::new();
    digest.update(b"tunnelde.plugin-storage.v1\0");
    digest.update((id.len() as u64).to_be_bytes());
    digest.update(id.as_bytes());
    digest.update(encoded);
    let revision = format!("s1:{:x}", digest.finalize());
    let changed = request.revision.as_ref() != Some(&revision);
    let response = serde_json::to_value(contracts::Observation {
        version: 1,
        revision: revision.clone(),
        changed,
        snapshot: changed.then_some(contracts::Snapshot {
            version: 1,
            revision,
            values,
        }),
    })?;
    if serde_json::to_vec(&response)?.len() > MAX_RESPONSE {
        return Err(invalid());
    }
    Ok(response)
}

#[cfg(test)]
mod tests;
