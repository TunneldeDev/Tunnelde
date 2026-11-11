use super::contracts::{Envelope, Reason};
use std::collections::HashSet;

pub(super) const MAX_OUTPUT: usize = 4096;

pub(super) fn decode(bytes: &[u8]) -> Result<Envelope, Reason> {
    if bytes.len() > MAX_OUTPUT {
        return Err(Reason::OutputTooLarge);
    }
    // Struct deserialization rejects duplicate recognized keys. Bounded unknown
    // fields/features can be ignored without granting new behavior.
    let value: Envelope = serde_json::from_slice(bytes).map_err(|_| Reason::InvalidResponse)?;
    if value.schema_version != 1 {
        return Err(Reason::UnsupportedSchema);
    }
    if value.helper != "tunnelde-agent"
        || value.helper_version.is_empty()
        || value.helper_version.len() > 64
        || !value
            .helper_version
            .bytes()
            .all(|byte| byte.is_ascii_graphic())
        || value.runner_protocols.len() > 32
        || value.runner_protocols.contains(&0)
        || value.runner_protocols.iter().collect::<HashSet<_>>().len()
            != value.runner_protocols.len()
        || value.features.len() > 32
        || value.features.iter().collect::<HashSet<_>>().len() != value.features.len()
        || value.features.iter().any(|feature| {
            feature.is_empty()
                || feature.len() > 64
                || !feature.bytes().all(|byte| {
                    byte.is_ascii_lowercase() || byte.is_ascii_digit() || b".-".contains(&byte)
                })
        })
        || (value
            .features
            .iter()
            .any(|feature| feature == "runner.control.v1")
            && !value.runner_protocols.contains(&1))
    {
        return Err(Reason::InvalidResponse);
    }
    Ok(value)
}
