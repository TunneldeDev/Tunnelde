//! Native multiwindow control plane and generation-fenced view ownership.
mod geometry;
pub(crate) mod native;
mod ownership;
mod protocol;
#[cfg(test)]
mod tests;
