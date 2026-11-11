//! Full public profile writes. Transport, staging and durable bytes have distinct owners.
pub(crate) mod contracts;
pub(crate) mod drafts;
mod planning;
pub(crate) use planning::{activation, delete, rename, save};

#[cfg(test)]
mod tests;
