//! Private protocol state. Never project admission tokens through the SDK.
use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(in crate::plugins::runners) struct Permit {
    schema_version: u32,
    token: String,
}

impl Permit {
    pub fn new() -> Self {
        Self {
            schema_version: 1,
            token: uuid::Uuid::new_v4().to_string(),
        }
    }
    pub fn token(&self) -> AppResult<&str> {
        if self.schema_version != 1
            || !uuid::Uuid::parse_str(&self.token)
                .is_ok_and(|id| !id.is_nil() && id.hyphenated().to_string() == self.token)
        {
            return Err(AppError::validation("plugin.runners.invalidMetadata"));
        }
        Ok(&self.token)
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum State {
    Reserved,
    Launched,
    Cancelled,
}

#[derive(Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum Status {
    Starting,
    Running,
    Stopping,
    Stopped,
    Failed,
    NotFound,
    Unresponsive,
}

impl Status {
    pub fn name(self) -> &'static str {
        match self {
            Self::Starting => "starting",
            Self::Running => "running",
            Self::Stopping => "stopping",
            Self::Stopped => "stopped",
            Self::Failed => "failed",
            Self::NotFound => "notFound",
            Self::Unresponsive => "unresponsive",
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(in crate::plugins::runners) struct Receipt {
    schema_version: u32,
    runner_id: String,
    token: String,
    pub(super) admission: State,
    pub(super) status: Status,
}

impl Receipt {
    pub(super) fn parse(bytes: &[u8], record: &super::super::Record) -> AppResult<Self> {
        let invalid = || AppError::validation("plugin.runners.invalidResponse");
        if bytes.len() > 4096 {
            return Err(invalid());
        }
        let value: Self = serde_json::from_slice(bytes).map_err(|_| invalid())?;
        value.validate(record)?;
        Ok(value)
    }
    fn validate(&self, record: &super::super::Record) -> AppResult<()> {
        let expected = record
            .admission
            .as_ref()
            .ok_or_else(|| AppError::validation("plugin.runners.invalidMetadata"))?
            .token()?;
        if self.schema_version != 1 || self.runner_id != record.runner_id || self.token != expected
        {
            return Err(AppError::validation("plugin.runners.invalidResponse"));
        }
        if self.admission == State::Reserved && self.status != Status::NotFound {
            return Err(AppError::validation("plugin.runners.invalidResponse"));
        }
        Ok(())
    }
    pub(in crate::plugins::runners) fn status(&self) -> &'static str {
        self.status.name()
    }
    pub(in crate::plugins::runners) fn reserved(&self) -> bool {
        self.admission == State::Reserved && self.status == Status::NotFound
    }
    pub(super) fn cancelled(&self) -> bool {
        self.admission == State::Cancelled
    }
    pub(in crate::plugins::runners) fn settle(
        &self,
        record: &mut super::super::Record,
    ) -> AppResult<()> {
        self.validate(record)?;
        if self.admission == State::Cancelled && self.status == Status::NotFound {
            // This proves admission is closed, not that a launch was acknowledged.
            let terminal = Some(super::super::model::TerminalState::NotFound);
            if record.stop_pending || record.terminal_status != terminal {
                record.stop_pending = false;
                record.terminal_status = terminal;
                record.advance()?;
            }
            Ok(())
        } else {
            record.settle(self.status())
        }
    }
}
