use super::{authority::Authority, operation::Control};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, PartialEq, Eq, Deserialize, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub(in super::super) enum Phase {
    Prepared,
    Running,
    Publishing,
    Succeeded,
    Conflict,
    Failed,
    Cancelled,
    Unknown,
    Releasing,
    Released,
}
#[derive(Clone, Copy, PartialEq, Eq, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub(in super::super) enum Publication {
    None,
    Published,
    Unknown,
}
#[derive(Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(in super::super) struct Observation {
    pub operation_id: String,
    pub generation: String,
    pub intent_sha256: String,
    pub revision: u64,
    pub phase: Phase,
    #[serde(deserialize_with = "required_nullable")]
    pub live: Option<bool>,
    pub cancellable: bool,
    pub publication: Publication,
    #[serde(deserialize_with = "required_nullable")]
    pub backup_retained: Option<bool>,
    #[serde(deserialize_with = "required_nullable")]
    pub error: Option<String>,
}
impl Observation {
    pub fn matches(&self, control: &Control) -> bool {
        self.operation_id == control.operation_id
            && self.generation == control.generation
            && self.intent_sha256 == control.intent_sha256
            && self.revision > 0
    }
    pub fn valid(&self) -> bool {
        let safe_error = self.error.as_ref().is_none_or(|e| {
            e.len() <= 127
                && e.starts_with("files.save.")
                && e.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.')
        });
        let publication = match self.phase {
            Phase::Prepared | Phase::Running | Phase::Failed | Phase::Cancelled => {
                self.publication == Publication::None
            }
            Phase::Succeeded | Phase::Conflict => self.publication == Publication::Published,
            Phase::Publishing => self.publication == Publication::Unknown,
            Phase::Unknown | Phase::Releasing | Phase::Released => true,
        };
        safe_error
            && publication
            && (!self.cancellable
                || (matches!(self.phase, Phase::Prepared | Phase::Running) && self.live.is_some()))
            && (!matches!(self.phase, Phase::Unknown | Phase::Releasing)
                || self.backup_retained.is_none())
            && (self.phase != Phase::Released || self.backup_retained == Some(false))
    }
    pub fn releasable(&self) -> bool {
        self.live == Some(false)
            && matches!(
                self.phase,
                Phase::Succeeded | Phase::Conflict | Phase::Failed | Phase::Cancelled
            )
            && self.backup_retained.is_some()
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(in super::super) struct Response {
    pub schema_version: u32,
    pub protocol: String,
    pub authority: Authority,
    pub binding_sha256: String,
    #[serde(deserialize_with = "required_nullable")]
    pub observation: Option<Observation>,
    pub cleanup_authorized: bool,
}

fn required_nullable<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}
