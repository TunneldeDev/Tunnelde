//! Pure companion writes in the owning host/network transaction. Never OS IO.
use super::bindings::{self, Owner};
use crate::{error::AppResult, models::Host, network::NetworkSettings};
use rusqlite::Connection;
use uuid::Uuid;

mod hosts;
mod network;
mod revisions;
mod trust;
pub(crate) use hosts::{host_changed, host_created, host_deleted, host_incarnation, route_changed};
pub(crate) use network::{
    feature_incarnation, network_changed, proxy_incarnation, selection_authority,
};
pub(crate) use trust::{trust_changed, trust_incarnation};

#[cfg(test)]
mod tests;
