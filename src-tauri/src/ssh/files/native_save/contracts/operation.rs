use super::{authority::Authority, hash, json_hash, MAX_TEXT};
use serde::{Deserialize, Serialize};

// Private authority is serializable for stdin and a future private journal, never Debug/log/IPC.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(in super::super) struct Control {
    pub schema_version: u32,
    pub authority_id: String,
    pub operation_id: String,
    pub generation: String,
    pub intent_sha256: String,
    pub token: String,
}
impl Control {
    pub fn valid(&self) -> bool {
        self.schema_version == 1
            && super::uuid(&self.authority_id)
            && super::uuid(&self.operation_id)
            && super::uuid(&self.generation)
            && super::digest(&self.intent_sha256)
            && super::digest(&self.token)
            && self.token.bytes().any(|b| b != b'0')
    }
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub(in super::super) enum Baseline {
    Absent,
    Existing { sha256: String, length: u64 },
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(in super::super) struct Intent {
    pub schema_version: u32,
    pub binding_sha256: String,
    pub target: Vec<String>,
    pub baseline: Baseline,
    pub payload_sha256: String,
    pub payload_length: u64,
}
impl Intent {
    pub fn valid(&self, platform: &str) -> bool {
        if self.schema_version != 1
            || !super::digest(&self.binding_sha256)
            || !super::digest(&self.payload_sha256)
            || self.payload_length > MAX_TEXT as u64
            || self.target.is_empty()
            || self.target.len() > 64
            || self.target.iter().map(String::len).sum::<usize>() > 4096
            || self.target.iter().any(|part| {
                part.is_empty()
                    || part.len() > 255
                    || part == "."
                    || part == ".."
                    || part.contains(['\0', '/'])
            })
            || matches!(&self.baseline, Baseline::Existing{sha256,length} if !super::digest(sha256) || *length > MAX_TEXT as u64)
        {
            return false;
        }
        !(platform == "windows"
            && self.target.iter().any(|part| {
                let name = part.split('.').next().unwrap_or("").to_ascii_uppercase();
                part.contains(['\\', ':'])
                    || part.ends_with(['.', ' '])
                    || matches!(name.as_str(), "CON" | "PRN" | "AUX" | "NUL")
                    || (name.len() == 4
                        && (name.starts_with("COM") || name.starts_with("LPT"))
                        && (b'1'..=b'9').contains(&name.as_bytes()[3]))
            }))
    }
    pub fn digest(&self) -> String {
        json_hash(b"tunnelde.files.save.intent.v1\0", self)
    }
}
pub(in super::super) struct Prepared {
    pub control: Control,
    pub intent: Intent,
    pub content: String,
}
impl Prepared {
    pub fn new(
        authority: &Authority,
        target: Vec<String>,
        baseline: Baseline,
        content: String,
    ) -> Option<Self> {
        if content.len() > MAX_TEXT {
            return None;
        }
        if !authority.valid(if authority.root.platform == "windows" {
            super::authority::Platform::Windows
        } else {
            super::authority::Platform::Posix
        }) {
            return None;
        }
        let intent = Intent {
            schema_version: 1,
            binding_sha256: authority.binding(),
            target,
            baseline,
            payload_sha256: hash(b"", content.as_bytes()),
            payload_length: content.len() as u64,
        };
        // Private independent 256-bit token, never derived from operation IDs.
        let token = rand::random::<[u8; 32]>()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        let control = Control {
            schema_version: 1,
            authority_id: authority.authority_id.clone(),
            operation_id: uuid::Uuid::new_v4().to_string(),
            generation: uuid::Uuid::new_v4().to_string(),
            intent_sha256: intent.digest(),
            token,
        };
        let value = Self {
            control,
            intent,
            content,
        };
        value.valid(authority).then_some(value)
    }
    pub fn valid(&self, authority: &Authority) -> bool {
        self.intent.valid(&authority.root.platform)
            && self.content.len() <= MAX_TEXT
            && self.control.valid()
            && self.control.authority_id == authority.authority_id
            && self.intent.binding_sha256 == authority.binding()
            && self.intent.digest() == self.control.intent_sha256
            && self.intent.payload_length == self.content.len() as u64
            && self.intent.payload_sha256 == hash(b"", self.content.as_bytes())
    }
}
#[derive(Serialize)]
#[serde(tag = "method", rename_all = "camelCase")]
pub(in super::super) enum Request<'a> {
    Initialize {
        #[serde(rename = "schemaVersion")]
        schema_version: u32,
        storage: &'static str,
        context: &'a super::authority::Context,
    },
    Submit {
        control: &'a Control,
        intent: &'a Intent,
        content: &'a str,
    },
    Status {
        control: &'a Control,
    },
    Cancel {
        control: &'a Control,
    },
    Release {
        control: &'a Control,
        revision: u64,
        #[serde(rename = "discardBackup")]
        discard_backup: bool,
    },
}
