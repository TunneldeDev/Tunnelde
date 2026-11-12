use super::{Error, Result};
use crate::ssh::{files::native_save::contracts, session::SessionIdentity};
use contracts::{
    authority::{Authority, Context, Platform},
    operation::{Control, Intent, Prepared},
    receipt::{Observation, Phase, Publication},
};
use serde::{Deserialize, Serialize};

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(in super::super) struct Owner {
    pub id: String,
    pub generation: String,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(in super::super) struct Selection {
    pub executable: String,
    pub directory: String,
    pub protocol: String,
}
/// No payload or token. Original account, authority and exact helper paths survive restart.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(in super::super) struct Binding {
    pub authority: Authority,
    pub intent: Intent,
    pub operation_id: String,
    pub generation: String,
    pub intent_sha256: String,
    pub token_sha256: String,
    pub owner: Owner,
    pub destination: SessionIdentity,
    pub selection: Selection,
}
impl Binding {
    pub fn new(
        authority: Authority,
        prepared: &Prepared,
        owner: Owner,
        destination: SessionIdentity,
        selection: Selection,
    ) -> Result<Self> {
        if !prepared.valid(&authority) {
            return Err(Error::Unrecognized);
        }
        let value = Self {
            authority,
            intent: prepared.intent.clone(),
            operation_id: prepared.control.operation_id.clone(),
            generation: prepared.control.generation.clone(),
            intent_sha256: prepared.control.intent_sha256.clone(),
            token_sha256: contracts::hash(b"", prepared.control.token.as_bytes()),
            owner,
            destination,
            selection,
        };
        value.valid().then_some(value).ok_or(Error::Unrecognized)
    }
    pub fn platform(&self) -> Platform {
        if self.authority.root.platform == "windows" {
            Platform::Windows
        } else {
            Platform::Posix
        }
    }
    pub fn valid(&self) -> bool {
        let platform = self.platform();
        self.authority.valid(platform)
            && self.intent.valid(&self.authority.root.platform)
            && self.intent.binding_sha256 == self.authority.binding()
            && self.intent.digest() == self.intent_sha256
            && contracts::uuid(&self.operation_id)
            && contracts::uuid(&self.generation)
            && contracts::digest(&self.token_sha256)
            && contracts::uuid(&self.owner.id)
            && contracts::uuid(&self.owner.generation)
            && !self.destination.host_id.is_empty()
            && self.destination.host_id.len() <= 256
            && self.destination.address.len() <= 2048
            && !self.destination.address.chars().any(char::is_control)
            && Context::authenticated(
                &self.destination,
                self.authority.context.scope.clone(),
                platform,
            ) == Some(self.authority.context.clone())
            && self.selection.protocol == contracts::PROTOCOL
            && platform.absolute(&self.selection.executable)
            && platform.absolute(&self.selection.directory)
    }
    pub fn control(&self, token: String) -> Result<Control> {
        let control = Control {
            schema_version: 1,
            authority_id: self.authority.authority_id.clone(),
            operation_id: self.operation_id.clone(),
            generation: self.generation.clone(),
            intent_sha256: self.intent_sha256.clone(),
            token,
        };
        if !control.valid() || contracts::hash(b"", control.token.as_bytes()) != self.token_sha256 {
            return Err(Error::SecretChanged);
        }
        Ok(control)
    }
    pub fn matches(&self, authority: &Authority, prepared: &Prepared) -> bool {
        self.authority == *authority
            && prepared.valid(authority)
            && self.operation_id == prepared.control.operation_id
            && self.generation == prepared.control.generation
            && self.intent_sha256 == prepared.control.intent_sha256
            && self.control(prepared.control.token.clone()).is_ok()
    }
    pub fn overlaps(&self, other: &Self) -> bool {
        // Do not let a changed key/root/account make an unresolved path writable.
        // Authority still binds recovery; address/path conservatively binds admission.
        if !self.same_host(&other.destination) {
            return false;
        }
        // Incompatible path namespaces on a potentially identical host cannot
        // establish disjointness. Recovery still requires the exact identity.
        self.platform() != other.platform()
            || self.path_conflict(&self.target_path(), &other.target_path())
    }
    pub fn same_host(&self, destination: &SessionIdentity) -> bool {
        self.destination.address == destination.address
            || self.destination.host_id == destination.host_id
            || self.authority.context.host_key == destination.server_key
    }
    pub fn target_path(&self) -> String {
        let scope = match self.platform() {
            Platform::Posix => self.authority.context.scope.trim_end_matches('/'),
            Platform::Windows => self.authority.context.scope.trim_end_matches(['/', '\\']),
        };
        format!("{scope}/{}", self.intent.target.join("/"))
    }
    pub fn overlaps_path(&self, other: &str) -> bool {
        // The original helper's private state contains publication receipts and
        // retained backups. Legacy cleanup/delete must preserve that authority too.
        [
            &self.target_path(),
            &self.selection.directory,
            &self.selection.executable,
        ]
        .iter()
        .any(|reserved| self.path_conflict(reserved, other))
    }
    fn path_conflict(&self, reserved: &str, other: &str) -> bool {
        use crate::services::files::admission::{Path, Platform as Paths};
        let platform = match self.platform() {
            Platform::Posix => Paths::Posix,
            Platform::Windows => Paths::Windows,
        };
        match (Path::new(reserved, platform), Path::new(other, platform)) {
            (Some(a), Some(b)) => a.overlaps(&b),
            // An unsupported path spelling is not proof of disjointness.
            _ => true,
        }
    }
}
#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(in super::super) enum Stage {
    Reserved,
    Ready,
    Dispatched,
    Abandoned,
    Retired,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(in super::super) struct Release {
    pub revision: u64,
    pub discard_backup: bool,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(in super::super) struct Record {
    pub journal_id: String,
    pub binding: Binding,
    pub revision: u64,
    pub stage: Stage,
    #[serde(deserialize_with = "required_nullable")]
    pub observation: Option<Observation>,
    #[serde(deserialize_with = "required_nullable")]
    pub release: Option<Release>,
}

fn required_nullable<'de, D, T>(deserializer: D) -> std::result::Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}
impl Record {
    pub fn secret_key(&self) -> String {
        format!(
            "{}:{}:{}",
            self.journal_id, self.binding.operation_id, self.binding.generation
        )
    }
    pub fn valid(&self) -> bool {
        contracts::uuid(&self.journal_id)
            && self.binding.valid()
            && self.revision > 0
            && self.revision <= i64::MAX as u64
            && self.release.as_ref().is_none_or(|release| {
                (self.stage == Stage::Dispatched || self.stage == Stage::Retired)
                    && release.revision > 0
                    && self.observation.is_some()
            })
            && self.observation.as_ref().is_none_or(|receipt| {
                (self.stage == Stage::Dispatched || self.stage == Stage::Retired)
                    && receipt.valid()
                    && receipt.operation_id == self.binding.operation_id
                    && receipt.generation == self.binding.generation
                    && receipt.intent_sha256 == self.binding.intent_sha256
                    && receipt.revision > 0
            })
            && (self.stage != Stage::Retired || self.released())
    }
    pub fn released(&self) -> bool {
        self.observation.as_ref().is_some_and(|receipt| {
            receipt.phase == Phase::Released
                && receipt.live == Some(false)
                && receipt.publication != Publication::Unknown
        })
    }
    pub fn occupies_worker(&self) -> bool {
        self.stage == Stage::Dispatched
            && !self.released()
            && (self.release.is_some()
                || !self
                    .observation
                    .as_ref()
                    .is_some_and(Observation::releasable))
    }
    pub fn disposable(&self) -> bool {
        self.stage == Stage::Abandoned || (self.stage == Stage::Retired && self.released())
    }
    pub fn blocks_target(&self) -> bool {
        !self.released() && !self.disposable()
    }
}
