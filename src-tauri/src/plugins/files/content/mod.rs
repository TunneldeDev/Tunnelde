//! Bounded descriptors and read handles use the shared runtime ownership registry.
pub(in crate::plugins) mod contracts;
mod entry;
mod registry;
pub(in crate::plugins) use entry::Entry;
pub(in crate::plugins) use registry::Content;

#[cfg(test)]
mod tests;
