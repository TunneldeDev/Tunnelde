//! Public mutation input. Internal session/runtime fields are never accepted.
use crate::automation::contract::Failure;
use crate::services::forwarding::contract::{validate, ForwardRule};
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Save {
    id: String,
    host_id: String,
    name: String,
    direction: String,
    bind: Endpoint,
    target: Endpoint,
    revision: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Endpoint {
    host: String,
    port: u16,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Existing {
    id: String,
    revision: String,
}

pub(super) enum Mutation {
    Save {
        rule: ForwardRule,
        revision: Option<String>,
    },
    Remove {
        id: String,
        revision: String,
    },
    Stop {
        id: String,
        revision: String,
    },
}
pub(super) fn token(value: &str) -> bool {
    !value.is_empty() && value.len() <= 128 && value.chars().all(display_char)
}
fn display_char(c: char) -> bool {
    !c.is_control() && !matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
}
pub(super) fn parse(method: &str, params: Value) -> Result<Mutation, Failure> {
    let invalid = || {
        Failure::new(
            "invalid_request",
            "Invalid forwarding mutation; check api.describe",
        )
    };
    match method {
        "forwards.save" => {
            // serde's Option (including a transparent wrapper) accepts a
            // missing field. The public creation sentinel must be explicit.
            if !params
                .as_object()
                .is_some_and(|fields| fields.contains_key("revision"))
            {
                return Err(invalid());
            }
            let input: Save = serde_json::from_value(params).map_err(|_| invalid())?;
            if !token(&input.id)
                || !token(&input.host_id)
                || input.revision.as_deref().is_some_and(|r| !token(r))
                || input.revision.is_none()
                    && uuid::Uuid::parse_str(&input.id)
                        .ok()
                        .is_none_or(|id| id.to_string() != input.id)
                || !input.name.chars().all(display_char)
                || !input.bind.host.chars().all(display_char)
                || !input.target.host.chars().all(display_char)
            {
                return Err(invalid());
            }
            let rule = ForwardRule {
                id: input.id,
                host_id: input.host_id,
                name: input.name,
                mode: input.direction,
                bind_host: input.bind.host,
                bind_port: input.bind.port,
                target_host: input.target.host,
                target_port: input.target.port,
            };
            validate(&rule).map_err(|_| invalid())?;
            Ok(Mutation::Save {
                rule,
                revision: input.revision,
            })
        }
        "forwards.remove" | "forwards.stop" => {
            let input: Existing = serde_json::from_value(params).map_err(|_| invalid())?;
            if !token(&input.id) || !token(&input.revision) {
                return Err(invalid());
            }
            if method == "forwards.remove" {
                Ok(Mutation::Remove {
                    id: input.id,
                    revision: input.revision,
                })
            } else {
                Ok(Mutation::Stop {
                    id: input.id,
                    revision: input.revision,
                })
            }
        }
        _ => Err(Failure::new(
            "unknown_method",
            "Unknown local forwarding method",
        )),
    }
}

impl Mutation {
    pub(super) fn id(&self) -> &str {
        match self {
            Self::Save { rule, .. } => &rule.id,
            Self::Remove { id, .. } | Self::Stop { id, .. } => id,
        }
    }
    pub(super) fn revision(&self) -> Option<&str> {
        match self {
            Self::Save { revision, .. } => revision.as_deref(),
            Self::Remove { revision, .. } | Self::Stop { revision, .. } => Some(revision),
        }
    }
    pub(super) fn outcome(&self) -> &'static str {
        match self {
            Self::Save { .. } => "saved",
            Self::Remove { .. } => "removed",
            Self::Stop { .. } => "stopped",
        }
    }
}
