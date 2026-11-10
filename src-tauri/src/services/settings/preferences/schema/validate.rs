//! The small vocabulary used by the fixed schemas. Unknown keywords fail closed.
use crate::error::AppResult;
use serde_json::Value;

const KEYWORDS: &[&str] = &[
    "$schema",
    "title",
    "type",
    "properties",
    "required",
    "additionalProperties",
    "maxProperties",
    "propertyNames",
    "items",
    "maxItems",
    "enum",
    "minimum",
    "maximum",
    "multipleOf",
    "maxLength",
    "x-maxBytes",
    "anyOf",
];

pub(in crate::services::settings::preferences) fn check(
    schema: &Value,
    value: &Value,
    path: &str,
) -> AppResult<()> {
    visit(schema, value, path, 0)
}

fn visit(schema: &Value, value: &Value, path: &str, depth: usize) -> AppResult<()> {
    let fail = || super::super::invalid(path);
    let Some(definition) = schema.as_object() else {
        return Err(fail());
    };
    if depth > 24
        || definition
            .keys()
            .any(|key| !KEYWORDS.contains(&key.as_str()))
    {
        return Err(fail());
    }
    if let Some(choices) = schema.get("anyOf").and_then(Value::as_array) {
        return choices
            .iter()
            .find_map(|choice| visit(choice, value, path, depth + 1).ok())
            .ok_or_else(fail);
    }
    let valid_type = match schema["type"].as_str() {
        Some("object") => value.is_object(),
        Some("array") => value.is_array(),
        Some("string") => value.is_string(),
        Some("boolean") => value.is_boolean(),
        Some("null") => value.is_null(),
        Some("integer") => value
            .as_f64()
            .is_some_and(|number| number.is_finite() && number.fract() == 0.0),
        Some("number") => value.as_f64().is_some_and(f64::is_finite),
        _ => false,
    };
    if !valid_type {
        return Err(fail());
    }
    if schema
        .get("enum")
        .and_then(Value::as_array)
        .is_some_and(|choices| !choices.contains(value))
    {
        return Err(fail());
    }
    if let Some(number) = value.as_f64() {
        if schema["minimum"]
            .as_f64()
            .is_some_and(|bound| number < bound)
            || schema["maximum"]
                .as_f64()
                .is_some_and(|bound| number > bound)
            || schema["multipleOf"].as_f64().is_some_and(|unit| {
                let ratio = number / unit;
                unit <= 0.0 || (ratio - ratio.round()).abs() > 1e-9
            })
        {
            return Err(fail());
        }
    }
    if let Some(text) = value.as_str() {
        if over(schema, "maxLength", text.chars().count()) || over(schema, "x-maxBytes", text.len())
        {
            return Err(fail());
        }
    }
    if let Some(items) = value.as_array() {
        if over(schema, "maxItems", items.len()) {
            return Err(fail());
        }
        for item in items {
            visit(&schema["items"], item, path, depth + 1)?;
        }
    }
    if let Some(fields) = value.as_object() {
        if over(schema, "maxProperties", fields.len()) {
            return Err(fail());
        }
        if let Some(required) = schema["required"].as_array() {
            if required
                .iter()
                .any(|key| key.as_str().is_none_or(|key| !fields.contains_key(key)))
            {
                return Err(fail());
            }
        }
        for (key, value) in fields {
            if let Some(names) = schema.get("propertyNames") {
                visit(names, &Value::String(key.clone()), path, depth + 1)?;
            }
            if let Some(child) = schema["properties"].get(key) {
                visit(child, value, &format!("{path}.{key}"), depth + 1)?;
            } else if schema["additionalProperties"].is_object() {
                visit(&schema["additionalProperties"], value, path, depth + 1)?;
            } else {
                return Err(fail());
            }
        }
    }
    Ok(())
}

fn over(schema: &Value, keyword: &str, length: usize) -> bool {
    schema[keyword]
        .as_u64()
        .is_some_and(|maximum| length as u64 > maximum)
}
