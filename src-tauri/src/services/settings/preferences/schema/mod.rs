//! Fixed host-owned schemas; plugins cannot supply executable validators.
mod validate;
use serde_json::{Map, Value};
use std::sync::LazyLock;
pub(super) use validate::check;

pub(super) fn groups() -> &'static Value {
    static GROUPS: LazyLock<Value> = LazyLock::new(|| {
        let groups: Map<_, _> = super::mapping::GROUPS
            .iter()
            .map(|group| {
                (
                    group.id.to_owned(),
                    serde_json::from_str(group.schema).expect("checked preference schema"),
                )
            })
            .collect();
        Value::Object(groups)
    });
    &GROUPS
}
