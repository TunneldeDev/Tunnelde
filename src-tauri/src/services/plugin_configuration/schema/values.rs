use super::super::{
    contracts::{
        document::Values,
        schema::{Declaration, ValueSchema},
    },
    MAX_DOCUMENT,
};
use crate::error::{AppError, AppResult};
use serde_json::Value;

impl Declaration {
    pub fn defaults(&self) -> Values {
        self.fields
            .iter()
            .map(|f| (f.id.clone(), f.default.clone()))
            .collect()
    }
    pub fn validate_values(&self, values: &Values) -> AppResult<()> {
        if serde_json::to_vec(values)?.len() > MAX_DOCUMENT {
            return Err(AppError::validation("configuration.limit"));
        }
        if values.len() != self.fields.len()
            || values
                .keys()
                .any(|key| !self.fields.iter().any(|f| &f.id == key))
        {
            return Err(AppError::validation("configuration.invalidValues"));
        }
        for field in &self.fields {
            field.schema.validate_value(
                values
                    .get(&field.id)
                    .ok_or_else(|| AppError::validation("configuration.invalidValues"))?,
                &field.id,
            )?;
        }
        Ok(())
    }
}

impl ValueSchema {
    pub(super) fn validate_value(&self, value: &Value, path: &str) -> AppResult<()> {
        let valid = match self {
            Self::String {
                max_length,
                min_length,
                choices,
            } => value.as_str().is_some_and(|v| {
                let len = v.chars().count();
                len <= *max_length as usize
                    && len >= min_length.unwrap_or(0) as usize
                    && !v.contains('\0')
                    && choices
                        .as_ref()
                        .is_none_or(|values| values.iter().any(|item| item == v))
            }),
            Self::Boolean { .. } => value.is_boolean(),
            Self::Number { minimum, maximum } => value
                .as_f64()
                .is_some_and(|v| v.is_finite() && v >= *minimum && v <= *maximum),
            Self::Integer { minimum, maximum } => value.as_f64().is_some_and(|v| {
                v.is_finite() && v.fract() == 0.0 && v >= *minimum as f64 && v <= *maximum as f64
            }),
            Self::Array { items, max_items } => {
                if let Some(values) = value.as_array() {
                    if values.len() > *max_items as usize {
                        false
                    } else {
                        for (index, child) in values.iter().enumerate() {
                            items.validate_value(child, &format!("{path}.{index}"))?;
                        }
                        true
                    }
                } else {
                    false
                }
            }
            Self::Object {
                properties,
                required,
                ..
            } => {
                if let Some(values) = value.as_object() {
                    if values.keys().any(|key| !properties.contains_key(key))
                        || required.iter().any(|key| !values.contains_key(key))
                    {
                        false
                    } else {
                        for (key, child) in values {
                            properties[key].validate_value(child, &format!("{path}.{key}"))?;
                        }
                        true
                    }
                } else {
                    false
                }
            }
        };
        if valid {
            Ok(())
        } else {
            Err(AppError::validation(format!(
                "configuration.invalidValue:{path}"
            )))
        }
    }
}
