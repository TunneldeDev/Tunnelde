//! Internal host invocations capture the selected runtime before waiting for it.
mod admission;
mod execution;
mod render;

// Includes native initialize and the frontend activate acknowledgement. The
// caller owns one absolute deadline, unaffected by unrelated policy changes.
const READY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

#[cfg(test)]
mod tests;
