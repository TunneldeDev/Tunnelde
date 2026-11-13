use serde_json::{json, Value};

pub(in super::super) fn method() -> Value {
    let shared: Value = serde_json::from_str(include_str!("../../../logs/read/schema.json"))
        .expect("checked persisted log schema");
    let compose = |name: &str| {
        let mut schema = shared["definitions"][name].clone();
        schema["definitions"] = shared["definitions"].clone();
        schema
    };
    json!({
        "name":"logs.read", "effect":"read", "stability":"experimental", "since":null,
        "inputSchema":compose("request"), "resultSchema":compose("page"),
        "errors":["invalid_request","operation_rejected","internal"],
        "description":"Read bounded persisted diagnostics or operations. Cursor binds this process, source and filter; it never selects a path. Diagnostic reads start within the recent 256KiB; operation retention is 1000. Pages contain at most 200 entries and 128KiB. Gaps/reset report incomplete history. Not a reliable audit stream. Local capability covers application and plugin logs; keep returned data private."
    })
}
