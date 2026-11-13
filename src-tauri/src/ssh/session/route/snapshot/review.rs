//! Opaque equality revision, not an authorization token. No proxy secrets or
//! internal route structures cross IPC. Restarting invalidates outstanding reviews.
use super::{ConnectionRoute, Node};
use sha2::{Digest, Sha256};
use std::sync::OnceLock;

fn salt() -> &'static [u8; 32] {
    static SALT: OnceLock<[u8; 32]> = OnceLock::new();
    SALT.get_or_init(rand::random)
}

pub(super) fn revision(
    nodes: &[Node],
    route: &ConnectionRoute,
    transport: impl FnOnce(&mut Sha256),
) -> String {
    let mut digest = Sha256::new();
    digest.update(b"tunnelde.ssh.prompt-review.v1\0");
    digest.update(salt());
    let inputs = serde_json::json!({
        "route": route,
        "nodes": nodes.iter().map(|node| {
            let host = &node.host;
            serde_json::json!([
                host.id, host.host, host.port, host.username,
                host.auth_method, host.key_path, node.key
            ])
        }).collect::<Vec<_>>()
    });
    let bytes = serde_json::to_vec(&inputs).expect("primitive review fields serialize");
    digest.update((bytes.len() as u64).to_le_bytes());
    digest.update(bytes);
    transport(&mut digest);
    digest.update(salt());
    format!("{:x}", digest.finalize())
}

#[cfg(test)]
mod tests;
