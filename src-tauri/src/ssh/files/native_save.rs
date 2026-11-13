//! Experimental desktop protocol adapter, separate from legacy SFTP and runners.
//! Explicit per-folder installation and native saves share durable recovery.
//! Public plugin save capability remains unadvertised and no runtime auto-installs.
mod client;
mod codec;
#[cfg(test)]
mod compatibility;
mod contracts;
mod journal;
pub(crate) mod runtime;
mod secrets;
mod service;
pub(in crate::ssh::files) mod setup;
mod transport;

#[cfg(test)]
pub(super) mod testing;
