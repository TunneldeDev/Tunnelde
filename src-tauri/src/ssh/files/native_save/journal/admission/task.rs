//! Immutable operation identity lives in the same transaction as its claim.
use super::*;
use crate::{
    services::files::admission::{Path, Platform},
    ssh::{files::native_save::contracts, session::SessionIdentity},
};
use serde::{Deserialize, Serialize};

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Endpoint {
    // Local endpoints also belong to the immutable intent. Their absence from
    // remote scopes does not permit changing the local half on continuation.
    pub path: String,
    pub remote: Option<SessionIdentity>,
}

impl Endpoint {
    fn valid(&self) -> bool {
        self.path.len() <= 8192
            && !self.path.chars().any(char::is_control)
            && (Path::new(&self.path, Platform::Posix).is_some()
                || Path::new(&self.path, Platform::Windows).is_some())
            && self.remote.as_ref().is_none_or(|identity| {
                super::model::Scope {
                    destination: identity.clone(),
                    platform: if Path::new(&self.path, Platform::Windows).is_some() {
                        "windows"
                    } else {
                        "posix"
                    }
                    .into(),
                    paths: vec![self.path.clone()],
                }
                .valid()
            })
    }
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Task {
    pub id: String,
    pub source: Endpoint,
    pub destination: Endpoint,
    pub remove_source: bool,
    pub overwrite: bool,
    pub plugin_id: Option<String>,
}

impl Task {
    pub(crate) fn valid(&self) -> bool {
        contracts::uuid(&self.id)
            && self.source.valid()
            && self.destination.valid()
            && self.source != self.destination
            && self
                .plugin_id
                .as_ref()
                .is_none_or(|id| crate::plugins::manifest::valid_id(id))
            && !(self.remove_source && self.plugin_id.is_some())
    }

    pub(super) fn matches_roots(&self, roots: &[Scope]) -> bool {
        let endpoints: Vec<_> = std::iter::once(&self.destination)
            .chain(self.remove_source.then_some(&self.source))
            .filter(|endpoint| endpoint.remote.is_some())
            .collect();
        !endpoints.is_empty()
            && endpoints.iter().all(|endpoint| {
                roots.iter().any(|scope| {
                    endpoint.remote.as_ref() == Some(&scope.destination)
                        && scope.paths.contains(&endpoint.path)
                })
            })
            && roots.iter().all(|scope| {
                scope.paths.len() % 2 == 0
                    && scope.paths.chunks_exact(2).all(|spellings| {
                        endpoints.iter().any(|endpoint| {
                            endpoint.remote.as_ref() == Some(&scope.destination)
                                && endpoint.path == spellings[0]
                        })
                    })
            })
    }
}
