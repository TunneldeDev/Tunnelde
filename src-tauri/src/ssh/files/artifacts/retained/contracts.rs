use super::super::*;

pub(super) const MAX_PER_TRANSFER: usize = 8;
pub(super) const MAX_TOTAL: usize = 128;
pub(super) const PREFIX: &str = "transfer-retained-creation:";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum Settlement {
    Unknown,
    Created,
    Rejected,
}

/// This record outlives the original transfer and its ordinary checkpoints.
/// Directory metadata is never a substitute for its terminal server reply.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Record {
    pub version: u8,
    pub task_id: String,
    pub parent_id: String,
    pub name: String,
    pub plugin_id: Option<String>,
    pub host_id: String,
    pub address: String,
    pub target: String,
    pub directory: String,
    pub generation: String,
    pub settlement: Settlement,
    pub updated_at: i64,
}

fn text(value: &str, max: usize) -> bool {
    !value.is_empty() && value.len() <= max && !value.chars().any(char::is_control)
}

impl Record {
    pub fn validate(&self) -> AppResult<()> {
        if self.version != 1
            || uuid::Uuid::parse_str(&self.task_id).is_err()
            || uuid::Uuid::parse_str(&self.generation).is_err()
            || !text(&self.parent_id, 128)
            || !self
                .parent_id
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))
            || self.plugin_id.as_ref().is_some_and(|id| !text(id, 128))
            || !text(&self.name, 4096)
            || !text(&self.host_id, 128)
            || !text(&self.address, 4096)
            || !text(&self.target, 4096)
            || !self.target.starts_with('/')
            || self.directory.len() > 4096
            || self.updated_at < 0
        {
            return Err(invalid());
        }
        let to = Endpoint {
            session: Some("metadata-only".into()),
            path: self.target.clone(),
        };
        let staging = RemoteStaging {
            generation: self.generation.clone(),
            prepared: false,
            opening: false,
            creating: true,
        };
        if staging_directory(&to, &self.parent_id, &staging)?.path != self.directory {
            return Err(invalid());
        }
        Ok(())
    }

    pub fn key(&self) -> String {
        format!("{PREFIX}{}", self.task_id)
    }

    pub fn owner_key(&self) -> String {
        owner_key(&self.parent_id, &self.directory)
    }

    pub fn task(&self) -> durable::DurableTransfer {
        durable::DurableTransfer {
            id: self.task_id.clone(),
            plugin_id: self.plugin_id.clone(),
            retained_creation: true,
            retained_settlement: Some(
                match self.settlement {
                    Settlement::Unknown => "unknown",
                    Settlement::Created => "created",
                    Settlement::Rejected => "rejected",
                }
                .into(),
            ),
            direction: "transfer".into(),
            name: self.name.clone(),
            from_session: None,
            from_host_id: None,
            from_address: None,
            from_path: String::new(),
            to_session: None,
            to_host_id: Some(self.host_id.clone()),
            to_address: Some(self.address.clone()),
            to_path: self.target.clone(),
            remove_source: false,
            deleting_source: false,
            move_recovery: None,
            directory_move_manifest: None,
            overwrite: false,
            transferred: 0,
            total: 0,
            speed_limit_kib: 0,
            status: "cleanupPending".into(),
            phase: None,
            error: Some(
                match self.settlement {
                    Settlement::Unknown => "sftp.retainedCreationUnknown",
                    _ => "sftp.retainedCreationSettled",
                }
                .into(),
            ),
            backup_recovery: None,
            artifact_recovery: Some(self.directory.clone()),
            updated_at: self.updated_at,
        }
    }
}

pub(super) fn invalid() -> AppError {
    AppError::validation("sftp.retainedCreationInvalid")
}

pub(super) fn owner_key(parent: &str, directory: &str) -> String {
    format!(
        "transfer-retained-owner:{parent}:{:x}",
        Sha256::digest(directory.as_bytes())
    )
}
