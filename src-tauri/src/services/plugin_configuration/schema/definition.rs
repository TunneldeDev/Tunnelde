use super::super::contracts::{
    migration::Operation,
    schema::{Declaration, ValueSchema},
};
use crate::error::{AppError, AppResult};
use sha2::{Digest, Sha256};
use std::collections::HashSet;

pub(crate) fn valid_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= 64
        && key
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
        && !["__proto__", "prototype", "constructor"].contains(&key)
}
pub(crate) fn digest_string(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
fn plain(value: &str, max: usize) -> bool {
    !value
        .trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
        .is_empty()
        && value.chars().count() <= max
        && !value.chars().any(|c| {
            c.is_control() || matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
        })
}
fn invalid() -> AppError {
    AppError::validation("configuration.invalidSchema")
}

impl Declaration {
    pub fn validate(&self) -> AppResult<()> {
        if !(1..=65535).contains(&self.version)
            || self.groups.is_empty()
            || self.groups.len() > 16
            || self.fields.is_empty()
            || self.fields.len() > 64
            || self.migrations.len() > 32
            || serde_json::to_vec(self)?.len() > 64 * 1024
        {
            return Err(invalid());
        }
        let mut groups = HashSet::new();
        for group in &self.groups {
            if !valid_key(&group.id) || !plain(&group.title, 120) || !groups.insert(&group.id) {
                return Err(invalid());
            }
        }
        let mut fields = HashSet::new();
        let mut nodes = 0;
        for field in &self.fields {
            if !valid_key(&field.id)
                || !fields.insert(&field.id)
                || !groups.contains(&field.group)
                || !plain(&field.title, 120)
                || field.description.as_ref().is_some_and(|v| !plain(v, 512))
            {
                return Err(invalid());
            }
            definition(&field.schema, 0, &mut nodes)?;
            field.schema.validate_value(&field.default, &field.id)?;
        }
        self.validate_values(&self.defaults())?;
        let mut sources = HashSet::new();
        for step in &self.migrations {
            if step.from_version == 0
                || step.to_version <= step.from_version
                || step.to_version > self.version
                || !digest_string(&step.from_digest)
                || !digest_string(&step.to_digest)
                || !sources.insert((step.from_version, &step.from_digest))
                || step.operations.len() > 128
            {
                return Err(invalid());
            }
            for op in &step.operations {
                let valid = match op {
                    Operation::Rename { from, to } => {
                        valid_key(from) && valid_key(to) && from != to
                    }
                    Operation::SetDefault { key, value } => {
                        valid_key(key)
                            && serde_json::to_vec(value)?.len() <= super::super::MAX_DOCUMENT
                    }
                    Operation::Remove { key } => valid_key(key),
                };
                if !valid {
                    return Err(invalid());
                }
            }
        }
        Ok(())
    }

    /// Labels/groups/ordering/migration history do not change the data contract.
    pub fn digest(&self) -> AppResult<String> {
        let fields: std::collections::BTreeMap<_, _> = self
            .fields
            .iter()
            .map(|field| {
                (
                    &field.id,
                    serde_json::json!({"schema":field.schema,"default":field.default}),
                )
            })
            .collect();
        Ok(format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&(self.version, fields))?)
        ))
    }
}

fn definition(schema: &ValueSchema, depth: usize, nodes: &mut usize) -> AppResult<()> {
    *nodes += 1;
    if depth > 8 || *nodes > 512 {
        return Err(invalid());
    }
    let valid = match schema {
        ValueSchema::String {
            max_length,
            min_length,
            choices,
        } => {
            *max_length <= 16384
                && min_length.is_none_or(|min| min <= *max_length)
                && choices.as_ref().is_none_or(|values| {
                    let unique: HashSet<_> = values.iter().collect();
                    !values.is_empty()
                        && values.len() <= 128
                        && unique.len() == values.len()
                        && values.iter().all(|v| {
                            v.chars().count() <= *max_length as usize
                                && v.chars().count() >= min_length.unwrap_or(0) as usize
                                && !v.contains('\0')
                        })
                })
        }
        ValueSchema::Boolean { .. } => true,
        ValueSchema::Number { minimum, maximum } => {
            minimum.is_finite() && maximum.is_finite() && minimum <= maximum
        }
        ValueSchema::Integer { minimum, maximum } => {
            minimum <= maximum
                && *minimum >= -9_007_199_254_740_991
                && *maximum <= 9_007_199_254_740_991
        }
        ValueSchema::Array { items, max_items } => {
            definition(items, depth + 1, nodes)?;
            *max_items <= 256
        }
        ValueSchema::Object {
            properties,
            required,
            additional_properties,
        } => {
            let unique: HashSet<_> = required.iter().collect();
            if properties.len() > 64
                || *additional_properties
                || unique.len() != required.len()
                || properties.keys().any(|key| !valid_key(key))
                || required.iter().any(|key| !properties.contains_key(key))
            {
                return Err(invalid());
            }
            for child in properties.values() {
                definition(child, depth + 1, nodes)?;
            }
            true
        }
    };
    if valid {
        Ok(())
    } else {
        Err(invalid())
    }
}
