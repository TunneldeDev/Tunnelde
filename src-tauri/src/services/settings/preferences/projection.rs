use super::{contracts::Snapshot, mapping::GROUPS};
use crate::{error::AppResult, settings::Settings};
use serde_json::{Map, Value};

pub(super) fn values(settings: &Settings) -> AppResult<Value> {
    let internal = serde_json::to_value(settings)?;
    let mut groups = Map::new();
    for group in GROUPS {
        let mut fields = Map::new();
        for &(public, private) in group.fields {
            let value = private.split('.').fold(&internal, |value, key| &value[key]);
            fields.insert(public.into(), value.clone());
        }
        groups.insert(group.id.into(), Value::Object(fields));
    }
    Ok(Value::Object(groups))
}

pub(super) fn snapshot(settings: &Settings, revision: String) -> AppResult<Snapshot> {
    let mut defaults = Settings::default();
    defaults.sanitize();
    Ok(Snapshot {
        version: 1,
        revision,
        values: values(settings)?,
        defaults: values(&defaults)?,
    })
}
