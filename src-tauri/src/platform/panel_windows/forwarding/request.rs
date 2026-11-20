use crate::services::forwarding::{automation::Options, contract::ForwardRule};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(
    tag = "operation",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum Request {
    PrepareStart {
        id: String,
        revision: String,
        interaction: String,
    },
    Start {
        id: String,
        revision: String,
        interaction: String,
        review: crate::ssh::session::review::Review,
        #[serde(default)]
        credentials: super::connection::Credentials,
    },
    Probe {
        id: String,
        revision: String,
        interaction: String,
        review: crate::ssh::session::review::Review,
        #[serde(default)]
        credentials: super::connection::JumpCredentials,
    },
    Trust {
        id: String,
        revision: String,
        interaction: String,
        review: crate::ssh::session::review::Review,
        fingerprint: String,
        expected_host_id: String,
        #[serde(default)]
        credentials: super::connection::JumpCredentials,
    },
    CredentialStatus {
        id: String,
        revision: String,
        interaction: String,
        review: crate::ssh::session::review::Review,
        host_id: String,
    },
    SaveCredential {
        id: String,
        revision: String,
        interaction: String,
        review: crate::ssh::session::review::Review,
        host_id: String,
        password: String,
    },
    ForgetCredential {
        id: String,
        revision: String,
        interaction: String,
        review: crate::ssh::session::review::Review,
        host_id: String,
    },
    Save {
        rule: ForwardRule,
        revision: Option<String>,
        group_id: Option<String>,
        automation: Options,
        interaction: Option<String>,
    },
    Stop {
        id: String,
        revision: String,
        runtime_id: Option<String>,
    },
    Remove {
        id: String,
        revision: String,
        runtime_id: Option<String>,
        interaction: String,
    },
    SaveGroup {
        host_id: String,
        name: String,
        id: Option<String>,
        revision: Option<String>,
    },
    RemoveGroup {
        id: String,
        revision: String,
    },
}
fn bounded(value: &str, max: usize) -> bool {
    !value.is_empty() && value.len() <= max && !value.chars().any(char::is_control)
}
impl Request {
    pub(super) fn interaction(&self) -> Option<&str> {
        match self {
            Self::Save {
                rule, interaction, ..
            } if !matches!(
                rule.bind_host.to_lowercase().as_str(),
                "localhost" | "127.0.0.1" | "::1" | "[::1]"
            ) =>
            {
                interaction.as_deref()
            }
            Self::Remove { interaction, .. }
            | Self::Start { interaction, .. }
            | Self::Probe { interaction, .. }
            | Self::Trust { interaction, .. }
            | Self::CredentialStatus { interaction, .. }
            | Self::SaveCredential { interaction, .. }
            | Self::ForgetCredential { interaction, .. }
            | Self::PrepareStart { interaction, .. } => Some(interaction),
            _ => None,
        }
    }
    pub(super) fn validate(&self) -> Result<(), &'static str> {
        let optional = |value: &Option<String>, max| value.as_ref().is_none_or(|v| bounded(v, max));
        let reviewed = |id: &str,
                        revision: &str,
                        interaction: &str,
                        review: &crate::ssh::session::review::Review| {
            bounded(id, 128)
                && bounded(revision, 256)
                && bounded(interaction, 128)
                && bounded(&review.host_id, 128)
                && review.identity().len() == 64
                && review.identity().bytes().all(|b| b.is_ascii_hexdigit())
        };
        let valid = match self {
            Self::PrepareStart {
                id,
                revision,
                interaction,
            } => bounded(id, 128) && bounded(revision, 256) && bounded(interaction, 128),
            Self::Start {
                id,
                revision,
                interaction,
                review,
                credentials,
            } => reviewed(id, revision, interaction, review) && credentials.valid(),
            Self::Probe {
                id,
                revision,
                interaction,
                review,
                credentials,
            } => reviewed(id, revision, interaction, review) && credentials.valid(),
            Self::Trust {
                id,
                revision,
                interaction,
                review,
                fingerprint,
                expected_host_id,
                credentials,
            } => {
                reviewed(id, revision, interaction, review)
                    && bounded(fingerprint, 256)
                    && bounded(expected_host_id, 128)
                    && credentials.valid()
            }
            Self::CredentialStatus {
                id,
                revision,
                interaction,
                review,
                host_id,
            }
            | Self::ForgetCredential {
                id,
                revision,
                interaction,
                review,
                host_id,
            } => reviewed(id, revision, interaction, review) && bounded(host_id, 128),
            Self::SaveCredential {
                id,
                revision,
                interaction,
                review,
                host_id,
                password,
            } => {
                reviewed(id, revision, interaction, review)
                    && bounded(host_id, 128)
                    && !password.is_empty()
                    && password.len() <= 128 * 1024
            }
            Self::Save {
                rule,
                revision,
                group_id,
                interaction,
                ..
            } => {
                crate::services::forwarding::contract::validate(rule).is_ok()
                    && bounded(&rule.host_id, 128)
                    && (rule.id.is_empty() == revision.is_none())
                    && optional(revision, 256)
                    && optional(group_id, 128)
                    && optional(interaction, 128)
                    && (matches!(
                        rule.bind_host.to_lowercase().as_str(),
                        "localhost" | "127.0.0.1" | "::1" | "[::1]"
                    ) || interaction.is_some())
            }
            Self::Stop {
                id,
                revision,
                runtime_id,
            } => bounded(id, 128) && bounded(revision, 256) && optional(runtime_id, 128),
            Self::Remove {
                id,
                revision,
                runtime_id,
                interaction,
            } => {
                bounded(id, 128)
                    && bounded(revision, 256)
                    && optional(runtime_id, 128)
                    && bounded(interaction, 128)
            }
            Self::SaveGroup {
                host_id,
                name,
                id,
                revision,
            } => {
                bounded(host_id, 128)
                    && !name.trim().is_empty()
                    && name.chars().count() <= 80
                    && !name.chars().any(char::is_control)
                    && id.is_some() == revision.is_some()
                    && optional(id, 128)
                    && optional(revision, 256)
            }
            Self::RemoveGroup { id, revision } => bounded(id, 128) && bounded(revision, 256),
        };
        if valid {
            Ok(())
        } else {
            Err("forward.invalid")
        }
    }
}
