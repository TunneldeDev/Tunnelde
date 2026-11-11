//! Negotiated cooperative launch admission; process recovery stays separate.
mod contracts;
mod transport;
pub(super) use contracts::Permit;
pub(super) use transport::{request, Operation};

pub(super) fn supported(result: &super::capabilities::contracts::Result) -> bool {
    matches!(result, super::capabilities::contracts::Result::Available { envelope }
        if super::bootstrap::supports(result)
            && envelope.features.iter().any(|feature| feature == "runner.admission-fence.v1"))
}

#[cfg(test)]
mod tests;
