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
pub(super) fn binding(authority: &Authority, prepared: &Prepared) -> super::journal::Binding {
    super::journal::Binding::new(
        authority.clone(),
        prepared,
        super::journal::Owner {
            id: uuid::Uuid::new_v4().to_string(),
            generation: uuid::Uuid::new_v4().to_string(),
        },
        crate::ssh::session::SessionIdentity {
            host_id: "isolated-test-host".into(),
            address: format!("{}@test.invalid:22", authority.context.account),
            server_key: authority.context.host_key.clone(),
        },
        super::journal::Selection {
            executable: if authority.root.platform == "windows" {
                r"C:\qa\agent.exe"
            } else {
                "/qa/agent"
            }
            .into(),
            directory: if authority.root.platform == "windows" {
                r"C:\qa\state"
            } else {
                "/qa/state"
            }
            .into(),
            protocol: super::contracts::PROTOCOL.into(),
        },
    )
    .unwrap()
}
pub(super) struct Checkpoint {
    pub root: std::path::PathBuf,
    journal: Option<super::journal::Journal>,
    permit: Option<super::journal::DispatchPermit>,
}
impl Checkpoint {
    pub fn new(authority: &Authority, prepared: &Prepared) -> Self {
        let root =
            std::env::temp_dir().join(format!("tunnelde-checkpoint-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let mut journal = super::journal::Journal::create(&root.join("journal")).unwrap();
        let record = journal.reserve(binding(authority, prepared)).unwrap();
        let record = journal.ready(&record).unwrap();
        let (_, permit) = journal.dispatch(&record).unwrap();
        Self {
            root,
            journal: Some(journal),
            permit: Some(permit),
        }
    }
    pub fn take(&mut self) -> super::journal::DispatchPermit {
        self.permit.take().unwrap()
    }
}
impl Drop for Checkpoint {
    fn drop(&mut self) {
        drop(self.journal.take());
        std::fs::remove_dir_all(&self.root).unwrap();
    }
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
