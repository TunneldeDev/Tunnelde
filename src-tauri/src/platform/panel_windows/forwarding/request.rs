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
            | Self::PrepareStart { interaction, .. } => Some(interaction),
            _ => None,
        }
    }
    pub(super) fn validate(&self) -> Result<(), &'static str> {
        let optional = |value: &Option<String>, max| value.as_ref().is_none_or(|v| bounded(v, max));
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
            } => {
                bounded(id, 128)
                    && bounded(revision, 256)
                    && bounded(interaction, 128)
                    && bounded(&review.host_id, 128)
                    && review.identity().len() == 64
                    && review.identity().bytes().all(|b| b.is_ascii_hexdigit())
                    && credentials.valid()
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
