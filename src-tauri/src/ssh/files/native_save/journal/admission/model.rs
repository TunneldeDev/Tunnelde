use super::*;
use crate::{
    services::files::admission::{Path, Platform},
    ssh::{files::native_save::contracts, session::SessionIdentity},
};
use serde::{Deserialize, Serialize};

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(in super::super::super::super) struct Scope {
    pub destination: SessionIdentity,
    pub platform: String,
    /// Both the requested spelling and canonical SFTP spelling are retained.
    pub paths: Vec<String>,
}
impl Scope {
    pub fn platform(&self) -> Option<Platform> {
        match self.platform.as_str() {
            "posix" => Some(Platform::Posix),
            "windows" => Some(Platform::Windows),
            _ => None,
        }
    }
    pub fn valid(&self) -> bool {
        let Some(platform) = self.platform() else {
            return false;
        };
        let native = match platform {
            Platform::Posix => contracts::authority::Platform::Posix,
            Platform::Windows => contracts::authority::Platform::Windows,
        };
        let identity = &self.destination;
        contracts::authority::Context::authenticated(
            identity,
            match platform {
                Platform::Posix => "/".into(),
                Platform::Windows => "C:/".into(),
            },
            native,
        )
        .is_some()
            && identity.host_id.len() <= 256
            && !identity.host_id.chars().any(char::is_control)
            && identity.address.len() <= 2048
            && !identity.address.chars().any(char::is_control)
            && !self.paths.is_empty()
            && self.paths.len() <= 32
            && self
                .paths
                .iter()
                .all(|path| Path::new(path, platform).is_some())
    }
    pub fn same_host(&self, destination: &SessionIdentity) -> bool {
        self.destination.host_id == destination.host_id
            || self.destination.address == destination.address
            || self.destination.server_key == destination.server_key
    }
    pub fn overlaps(&self, other: &Self) -> bool {
        if !self.same_host(&other.destination) {
            return false;
        }
        let (Some(platform), Some(other_platform)) = (self.platform(), other.platform()) else {
            return true;
        };
        platform != other_platform
            || self.paths.iter().any(|left| {
                other.paths.iter().any(|right| {
                    match (Path::new(left, platform), Path::new(right, platform)) {
                        (Some(a), Some(b)) => a.overlaps(&b),
                        _ => true,
                    }
                })
            })
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Kind {
    Create,
    Mkdir,
    Rename,
    Delete,
    Editor,
    Transfer,
    Cleanup,
}
#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(in super::super::super::super) enum Phase {
    Prepared,
    Dispatched,
    /// Original worker observed all requests finish; only the same owner may resume.
    Recoverable,
    /// Original worker sealed every request; awaiting synced application projection.
    Terminal,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(in super::super::super::super) struct Claim {
    pub journal_id: String,
    pub id: String,
    pub owner: Owner,
    pub revision: u64,
    pub kind: Kind,
    pub phase: Phase,
    pub scopes: Vec<Scope>,
    /// Immutable original transfer roots, distinct from subsequently enrolled
    /// staging/backup paths. Older internal records without them cannot resume.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transfer_roots: Option<Vec<Scope>>,
    /// Absent only on historical/internal unbound claims. Never adopt a task
    /// from a resettable application row when this original binding is absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transfer_task: Option<TransferTask>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal: Option<TransferOutcome>,
}
impl Claim {
    pub fn valid(&self) -> bool {
        contracts::uuid(&self.journal_id)
            && contracts::uuid(&self.id)
            && contracts::uuid(&self.owner.id)
            && contracts::uuid(&self.owner.generation)
            && (1..=i64::MAX as u64).contains(&self.revision)
            && match self.phase {
                Phase::Prepared => self.revision == 1,
                Phase::Dispatched => self.revision >= 2 && self.revision % 2 == 0,
                Phase::Recoverable => {
                    matches!(self.kind, Kind::Editor | Kind::Transfer)
                        && self.revision >= 3
                        && self.revision % 2 != 0
                }
                Phase::Terminal => {
                    self.kind == Kind::Transfer
                        && self.transfer_task.is_some()
                        && self.revision >= 3
                        && self.revision % 2 != 0
                }
            }
            && (self.phase == Phase::Terminal) == self.terminal.is_some()
            && self.terminal.as_ref().is_none_or(TransferOutcome::valid)
            && !self.scopes.is_empty()
            && self.scopes.len() <= 4
            && self.scopes.iter().map(|s| s.paths.len()).sum::<usize>() <= 32
            && self.scopes.iter().all(Scope::valid)
            && self.transfer_task.as_ref().is_none_or(|task| {
                self.kind == Kind::Transfer
                    && task.valid()
                    && task.id == self.owner.id
                    && self
                        .transfer_roots
                        .as_ref()
                        .is_some_and(|roots| task.matches_roots(roots))
            })
            && self.transfer_roots.as_ref().is_none_or(|roots| {
                self.kind == Kind::Transfer
                    && roots.len() == self.scopes.len()
                    && roots.iter().zip(&self.scopes).all(|(root, scope)| {
                        root.valid()
                            && root.destination == scope.destination
                            && root.platform == scope.platform
                            && scope.paths.starts_with(&root.paths)
                    })
                    && (self.phase != Phase::Prepared || *roots == self.scopes)
            })
    }
    pub fn overlaps_native(&self, binding: &super::super::Binding) -> bool {
        self.scopes.iter().any(|scope| {
            binding.same_host(&scope.destination)
                && (Some(match binding.platform() {
                    contracts::authority::Platform::Posix => Platform::Posix,
                    contracts::authority::Platform::Windows => Platform::Windows,
                }) != scope.platform()
                    || scope.paths.iter().any(|path| binding.overlaps_path(path)))
        })
    }
    pub fn overlaps(&self, scopes: &[Scope]) -> bool {
        self.scopes
            .iter()
            .any(|left| scopes.iter().any(|right| left.overlaps(right)))
    }
}
