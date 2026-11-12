//! Durable mutation intent; neither path absence nor matching bytes are receipts.
use super::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum Operation {
    Create,
    Stage,
    Publish,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Receipt {
    version: u8,
    generation: String,
    revision: u64,
    pending: Option<Operation>,
    created: bool,
}

impl Receipt {
    pub fn new() -> Self {
        Self {
            version: 1,
            generation: uuid::Uuid::new_v4().to_string(),
            revision: 0,
            pending: None,
            created: false,
        }
    }

    pub fn validate(&self) -> AppResult<()> {
        if self.version != 1
            || uuid::Uuid::parse_str(&self.generation).is_err()
            || (self.pending == Some(Operation::Create) && self.created)
            || (matches!(self.pending, Some(Operation::Stage | Operation::Publish))
                && !self.created)
        {
            return Err(AppError::validation("editor.cleanupUnrecognized"));
        }
        Ok(())
    }

    pub fn is_unsent(&self) -> bool {
        self.revision == 0 && self.pending.is_none() && !self.created && self.validate().is_ok()
    }

    pub fn follows(&self, previous: &Self) -> bool {
        self.validate().is_ok()
            && self.generation == previous.generation
            && (self == previous || previous.revision.checked_add(1) == Some(self.revision))
    }
}

pub(super) fn require_settled(record: &Record) -> AppResult<bool> {
    let receipt = record
        .receipt
        .as_ref()
        .ok_or_else(|| AppError::validation("editor.remoteOutcomeUnknown"))?;
    receipt.validate()?;
    if receipt.pending.is_some() {
        return Err(AppError::validation("editor.remoteOutcomeUnknown"));
    }
    Ok(receipt.created)
}

pub(super) fn begin(
    record: &mut Record,
    operation: Operation,
    checkpoint: &impl Fn(&Record) -> AppResult<()>,
) -> AppResult<()> {
    require_settled(record)?;
    let receipt = record.receipt.as_mut().unwrap();
    receipt.revision = receipt
        .revision
        .checked_add(1)
        .ok_or_else(|| AppError::validation("editor.cleanupUnrecognized"))?;
    receipt.pending = Some(operation);
    record.updated_at = crate::models::now_ms();
    checkpoint(record)
}

/// Only an actual terminal reply may settle an intent. Retain pending in memory
/// too if durable acknowledgement fails, so error cleanup cannot erase intent.
pub(super) fn settle(
    record: &mut Record,
    created: bool,
    checkpoint: &impl Fn(&Record) -> AppResult<()>,
) -> AppResult<()> {
    let previous = record.receipt.clone();
    let receipt = record
        .receipt
        .as_mut()
        .ok_or_else(|| AppError::validation("editor.remoteOutcomeUnknown"))?;
    receipt.validate()?;
    if receipt.pending.is_none() {
        return Err(AppError::validation("editor.cleanupUnrecognized"));
    }
    receipt.pending = None;
    receipt.revision = receipt
        .revision
        .checked_add(1)
        .ok_or_else(|| AppError::validation("editor.cleanupUnrecognized"))?;
    receipt.created = created;
    record.updated_at = crate::models::now_ms();
    if let Err(error) = checkpoint(record) {
        record.receipt = previous;
        return Err(error);
    }
    Ok(())
}

pub(super) fn terminal(error: &russh_sftp::client::error::Error) -> bool {
    matches!(error, russh_sftp::client::error::Error::Status(_))
}

/// Staging mutations are serialized; no pipelined write can outlive a terminal
/// failed response and race cleanup on the independent inspection connection.
pub(super) async fn mutation<T>(
    record: &mut Record,
    checkpoint: &impl Fn(&Record) -> AppResult<()>,
    operation: impl std::future::Future<Output = Result<T, russh_sftp::client::error::Error>>,
) -> AppResult<T> {
    begin(record, Operation::Stage, checkpoint)?;
    let result = operation.await;
    if result.is_ok() || result.as_ref().is_err_and(terminal) {
        settle(record, true, checkpoint)?;
    }
    result.map_err(map_sftp)
}
