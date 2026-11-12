use super::{
    contracts::{
        authority::{Authority, Context, ObjectIdentity},
        operation::{Baseline, Control, Prepared},
    },
    transport::Output,
};
use serde_json::{json, Value};
pub(super) fn authority() -> Authority {
    let identity = ObjectIdentity {
        platform: "linux".into(),
        device: "1".into(),
        object: "2".into(),
        created: "3".into(),
    };
    Authority {
        authority_id: "e78e3dd2-ae4d-4bea-99c0-ccf18157237a".into(),
        context: Context {
            host_key: format!("SHA256:{}", "A".repeat(43)),
            account: "user@domain".into(),
            scope: "/workspace".into(),
        },
        root: identity.clone(),
        storage_root: ObjectIdentity {
            object: "4".into(),
            ..identity
        },
    }
}
pub(super) fn prepared(authority: &Authority) -> Prepared {
    Prepared::new(
        authority,
        vec!["目录".into(), "quoted\".txt".into()],
        Baseline::Absent,
        "line\n😀\0".into(),
    )
    .unwrap()
}
pub(super) fn response(
    authority: &Authority,
    control: Option<&Control>,
    phase: &str,
    revision: u64,
) -> Value {
    json!({"schemaVersion":1,"protocol":"files.save.v1","authority":authority,"bindingSha256":authority.binding(),
    "cleanupAuthorized":false,"observation":control.map(|c| json!({
        "operationId":c.operation_id,"generation":c.generation,"intentSha256":c.intent_sha256,"revision":revision,
        "phase":phase,"live":false,"cancellable":matches!(phase,"prepared"|"running"),
        "publication":match phase { "succeeded"|"conflict"|"released"|"releasing"=>"published","unknown"|"publishing"=>"unknown",_=>"none" },
        "backupRetained":if matches!(phase,"unknown"|"releasing") { Value::Null } else { json!(phase=="conflict") },"error":null
    }))})
}
pub(super) fn output(value: Value) -> Output {
    Output {
        stdout: serde_json::to_vec(&value).unwrap(),
        stderr: Vec::new(),
        code: Some(0),
    }
}
