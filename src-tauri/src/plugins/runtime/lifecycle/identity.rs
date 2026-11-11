use super::contracts::handle::Kind;
use crate::plugins::api::HostContext;
use sha2::{Digest, Sha256};

pub(super) fn handle(context: &HostContext, kind: Kind, identity: &str) -> String {
    digest(
        &context.id,
        &context.fingerprint,
        context.generation,
        kind,
        identity,
    )
}
fn digest(owner: &str, fingerprint: &str, generation: u64, kind: Kind, identity: &str) -> String {
    // This is an identifier, never an authorization credential. Every action
    // still verifies current lease and exact domain ownership.
    let bytes = serde_json::to_vec(&(
        "runtime-resource-v1",
        owner,
        fingerprint,
        generation,
        kind,
        identity,
    ))
    .expect("resource identity serializes");
    format!("{:x}", Sha256::digest(bytes))
}
pub(super) fn valid(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

#[cfg(test)]
#[path = "tests/identity.rs"]
mod tests;
