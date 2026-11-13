//! Compose the existing domain schemas; no second preference-field catalogue.
use serde_json::{json, Value};

pub(in super::super) fn describe() -> crate::services::settings::preferences::contracts::Schema {
    let mut schema = crate::services::settings::preferences::describe();
    // Stability belongs to this local adapter's frozen v1 projection. The
    // separate plugin adapter and its additional methods remain experimental.
    schema.stability = "stable";
    schema
}

pub(in super::super) fn methods() -> Vec<Value> {
    let mut groups = crate::services::settings::preferences::describe().groups;
    for group in groups
        .as_object_mut()
        .expect("preference groups")
        .values_mut()
    {
        group
            .as_object_mut()
            .expect("group schema")
            .remove("$schema");
    }
    let names: Vec<_> = groups.as_object().unwrap().keys().cloned().collect();
    let values =
        json!({"type":"object","required":names,"properties":groups,"additionalProperties":false});
    let revision = json!({"type":"string","minLength":1,"maxLength":128,"x-maxBytes":128,"not":{"pattern":"[\\u0000-\\u001f\\u007f-\\u009f]"}});
    let snapshot = json!({
        "type":"object", "required":["version","revision","values","defaults"], "additionalProperties":false,
        "properties":{"version":{"const":1},"revision":revision,"values":values,"defaults":values}
    });
    let mut changes = values;
    changes.as_object_mut().unwrap().remove("required");
    for group in changes["properties"].as_object_mut().unwrap().values_mut() {
        group.as_object_mut().unwrap().remove("required");
    }
    let mut methods = vec![
        json!({"name":"preferences.schema","effect":"read","inputSchema":{"type":"object","additionalProperties":false},
            "resultSchema":{"type":"object","required":["version","stability","groups"],"additionalProperties":false,
                "properties":{"version":{"const":1},"stability":{"const":describe().stability},"groups":{"const":describe().groups}}}}),
        json!({"name":"preferences.snapshot","effect":"read","inputSchema":{"type":"object","additionalProperties":false},"resultSchema":snapshot}),
        json!({"name":"preferences.update","effect":"write","inputSchema":{"type":"object","required":["revision","changes"],"additionalProperties":false,
                "properties":{"revision":revision,"changes":changes}},"resultSchema":snapshot,
            "errors":["stale_revision","invalid_preferences","operation_rejected","internal"]}),
    ];
    for method in &mut methods {
        method["stability"] = json!("stable");
        method["since"] = json!("0.38.0-beta.1");
    }
    methods
}
