//! Private durable records. Public snapshots live in contracts.rs.
use super::lifecycle;
use serde::{Deserialize, Serialize};

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Deployment {
    pub(super) host_id: String,
    pub(super) directory: String,
    pub(super) platform: String,
    pub(super) executable: String,
    pub(super) runner: String,
    pub(super) entry: String,
    #[serde(default)]
    pub(super) fingerprint: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) identity: Option<crate::ssh::session::SessionIdentity>,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Record {
    pub(super) runner_id: String,
    pub(super) deployment: Deployment,
    pub(super) stop_pending: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) runtime_owner: Option<lifecycle::Owner>,
    #[serde(default)]
    pub(super) revision: u64,
    #[serde(default)]
    pub(super) launch_state: LaunchState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) controller_fingerprint: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) terminal_status: Option<TerminalState>,
}

#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum TerminalState {
    Stopped,
    Failed,
    NotFound,
}

/// Legacy records represent launches already acknowledged by the helper.
#[derive(Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum LaunchState {
    Reserved,
    Unconfirmed,
    #[default]
    Confirmed,
}

impl Record {
    pub(super) fn advance(&mut self) -> crate::error::AppResult<()> {
        self.revision = self.revision.checked_add(1).ok_or_else(|| {
            crate::error::AppError::validation("plugin.runners.revisionExhausted")
        })?;
        Ok(())
    }

    pub(super) fn same_revision(&self, observed: &Self) -> bool {
        self == observed
    }

    pub(super) fn controller(&self) -> &str {
        self.controller_fingerprint
            .as_deref()
            .unwrap_or(&self.deployment.fingerprint)
    }

    pub(super) fn settle(&mut self, status: &str) -> crate::error::AppResult<()> {
        let terminal = matches!(status, "stopped" | "failed")
            || (status == "notFound" && self.launch_state != LaunchState::Unconfirmed);
        let confirmed = matches!(status, "running" | "starting" | "stopped" | "failed");
        let terminal_status = match status {
            "stopped" => Some(TerminalState::Stopped),
            "failed" => Some(TerminalState::Failed),
            "notFound" if terminal => Some(TerminalState::NotFound),
            _ => None,
        };
        let status_changed = terminal && self.terminal_status != terminal_status;
        let clear_terminal =
            matches!(status, "running" | "starting") && self.terminal_status.is_some();
        let changed = (terminal && self.stop_pending)
            || (confirmed && self.launch_state != LaunchState::Confirmed)
            || status_changed
            || clear_terminal;
        if terminal {
            self.stop_pending = false;
        }
        if confirmed {
            self.launch_state = LaunchState::Confirmed;
        }
        if terminal {
            self.terminal_status = terminal_status;
        }
        if clear_terminal {
            self.terminal_status = None;
        }
        if changed {
            self.advance()?;
        }
        Ok(())
    }
}
