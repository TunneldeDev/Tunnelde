use serde::Deserialize;

use super::handle::Kind;
use crate::error::{AppError, AppResult};

/// Public domain IDs locate an observation; only the resulting handle identifies
/// the exact instance. Neither is an ownership credential.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Reference {
    pub kind: Kind,
    pub id: String,
}

impl Reference {
    pub fn validate(&self) -> AppResult<()> {
        if self.id.is_empty() || self.id.len() > 512 || self.id.chars().any(char::is_control) {
            return Err(AppError::validation("plugin.resources.invalidRequest"));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn only_supported_bounded_domain_selectors_are_accepted() {
        for kind in ["connection", "forward", "mount", "task", "transfer"] {
            let reference: Reference =
                serde_json::from_value(json!({"kind":kind,"id":"resource-id"})).unwrap();
            reference.validate().unwrap();
        }
        for value in [
            json!({}),
            json!({"kind":"runner","id":"id"}),
            json!({"kind":"connection","id":null}),
            json!({"kind":"connection","id":"id","pluginId":"other"}),
            json!({"kind":"connection","id":"id","generation":99}),
        ] {
            assert!(serde_json::from_value::<Reference>(value).is_err());
        }
        for id in [String::new(), "x".repeat(513), "a\0b".into(), "a\nb".into()] {
            let reference = Reference {
                kind: Kind::Task,
                id,
            };
            assert!(reference.validate().is_err());
        }
        assert!(Reference {
            kind: Kind::Task,
            id: "é".repeat(256)
        }
        .validate()
        .is_ok());
        assert!(Reference {
            kind: Kind::Task,
            id: "é".repeat(257)
        }
        .validate()
        .is_err());
    }
}
