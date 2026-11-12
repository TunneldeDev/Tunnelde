//! Experimental desktop protocol adapter, separate from legacy SFTP and runners.
//! No installation, capability advertisement, public RPC or UI path is enabled here.
mod client;
mod codec;
#[cfg(test)]
mod compatibility;
mod contracts;
mod journal;
mod secrets;
mod service;
mod transport;

#[cfg(test)]
mod testing;
