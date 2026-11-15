use super::revisions::{read as read_incarnation, rotate};
use super::*;

fn selector_key(selector: &str) -> String {
    use sha2::{Digest, Sha256};
    format!(
        "credentials.network.selector.{:x}",
        Sha256::digest(selector.as_bytes())
    )
}
pub(crate) fn network_changed(
    conn: &Connection,
    previous: &NetworkSettings,
    next: &NetworkSettings,
) -> AppResult<()> {
    if conn.is_autocommit() {
        return Err(crate::error::AppError::internal(
            "credentials.transactionRequired",
        ));
    }
    for old in &previous.profiles {
        let same = next
            .profiles
            .iter()
            .find(|p| p.id == old.id)
            .is_some_and(|p| {
                p.protocol == old.protocol
                    && p.host == old.host
                    && p.port == old.port
                    && p.username == old.username
            });
        if !same {
            bindings::invalidate(conn, &Owner::proxy(&old.id)?)?;
        }
    }
    for new in &next.profiles {
        if !previous.profiles.iter().any(|p| p.id == new.id) {
            bindings::invalidate(conn, &Owner::proxy(&new.id)?)?;
        }
    }
    if previous.default_proxy != next.default_proxy {
        rotate(conn, &selector_key("default"))?;
    }
    let features: std::collections::BTreeSet<_> = previous
        .features
        .keys()
        .chain(next.features.keys())
        .collect();
    for feature in features {
        let value =
            |network: &NetworkSettings| network.features.get(feature).cloned().unwrap_or_default();
        if value(previous) != value(next) {
            rotate(conn, &selector_key(&format!("feature:{feature}")))?;
        }
    }
    Ok(())
}

pub(crate) fn proxy_incarnation(conn: &Connection, id: &str) -> AppResult<Option<Uuid>> {
    Ok(bindings::capture(conn, &Owner::proxy(id)?)?.incarnation())
}

pub(crate) fn feature_incarnation(conn: &Connection, feature: &str) -> AppResult<Option<Uuid>> {
    read_incarnation(conn, &selector_key(&format!("feature:{feature}")))
}

/// Equality material for only the effective feature/override dependencies.
/// Unrelated profiles/features and cosmetic edits never revoke a captured route.
pub(crate) fn selection_authority(
    conn: &Connection,
    network: &NetworkSettings,
    feature: &str,
    override_value: Option<&str>,
) -> AppResult<Vec<u8>> {
    use sha2::{Digest, Sha256};
    let selected = crate::network::proxy::Selected::capture(network, feature, override_value)?;
    let mut digest = Sha256::new();
    digest.update(b"tunnelde.proxy.authority.v1\0");
    selected.update_review(&mut digest);
    let mut ids = vec![];
    if override_value.is_none_or(str::is_empty) {
        ids.push(read_incarnation(
            conn,
            &selector_key(&format!("feature:{feature}")),
        )?);
        if network.features.get(feature).is_none_or(String::is_empty) {
            ids.push(read_incarnation(conn, &selector_key("default"))?);
        }
    }
    if let crate::network::proxy::Selected::Profile { id, .. } = selected {
        ids.push(proxy_incarnation(conn, &id)?);
    }
    digest.update(serde_json::to_vec(&ids)?);
    Ok(digest.finalize().to_vec())
}
