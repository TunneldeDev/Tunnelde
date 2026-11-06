use serde::{Deserialize, Serialize};

/// Persisted identities are platform tagged; a copied profile must never
/// reinterpret another filesystem's file identifier as its own.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "platform", rename_all = "camelCase")]
pub enum FileIdentity {
    Windows {
        volume: u64,
        index: [u8; 16],
        created: u64,
    },
}
