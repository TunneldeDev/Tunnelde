//! Generations are process-local. Persist the boot identity as well so a delayed
//! cleanup cannot confuse a new task with an old process's reused generation.
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

fn boot_id() -> &'static str {
    static BOOT: OnceLock<String> = OnceLock::new();
    BOOT.get_or_init(|| uuid::Uuid::new_v4().to_string())
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::plugins::runners) struct Owner {
    boot_id: String,
    generation: u64,
}

impl Owner {
    pub(in crate::plugins::runners) fn current(generation: u64) -> Self {
        Self {
            boot_id: boot_id().into(),
            generation,
        }
    }

    pub(super) fn retired_before(&self, boundary: u64) -> bool {
        self.boot_id != boot_id() || self.generation < boundary
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn boundary_never_retires_replacement_and_previous_boots_do_not_collide() {
        assert!(Owner::current(9).retired_before(10));
        assert!(!Owner::current(10).retired_before(10));
        assert!(!Owner::current(11).retired_before(10));
        let previous: Owner = serde_json::from_value(serde_json::json!({
            "bootId": "previous-process", "generation": 10_000,
        }))
        .unwrap();
        assert!(previous.retired_before(10));
    }
}
