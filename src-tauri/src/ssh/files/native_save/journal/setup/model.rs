//! Host-owned installation intent, without remote control tokens or file payloads.
use super::super::{Owner, Selection};
use crate::{
    services::files::admission::{Path, Platform as Paths},
    ssh::{
        files::native_save::contracts::{
            self,
            authority::{Authority, Context, Platform},
        },
        session::SessionIdentity,
    },
};
use serde::{Deserialize, Serialize};

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(in crate::ssh::files::native_save) struct Package {
    pub version: String,
    pub platform: String,
    pub sha256: String,
}
impl Package {
    pub fn platform(&self) -> Option<Platform> {
        match self.platform.as_str() {
            "linux-x86_64" | "linux-aarch64" | "macos-x86_64" | "macos-aarch64" => {
                Some(Platform::Posix)
            }
            "windows-x86_64" => Some(Platform::Windows),
            _ => None,
        }
    }
    fn valid(&self) -> bool {
        self.version.len() <= 64
            && semver::Version::parse(&self.version).is_ok_and(|version| {
                version.pre.is_empty()
                    && version.build.is_empty()
                    && version.to_string() == self.version
            })
            && self.platform().is_some()
            && contracts::digest(&self.sha256)
    }
    fn matches(&self, authority: &Authority) -> bool {
        self.platform
            .split_once('-')
            .is_some_and(|(os, _)| os == authority.root.platform)
    }
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(in crate::ssh::files::native_save) struct Plan {
    pub destination: SessionIdentity,
    pub context: Context,
    pub install_directory: String,
    pub selection: Selection,
    pub package: Package,
}
impl Plan {
    pub fn valid(&self) -> bool {
        let Some(platform) = self.package.platform() else {
            return false;
        };
        let identity = &self.destination;
        let paths = self.paths();
        let Some(install) = Path::new(&self.install_directory, paths) else {
            return false;
        };
        let Some(executable) = Path::new(&self.selection.executable, paths) else {
            return false;
        };
        let Some(state) = Path::new(&self.selection.directory, paths) else {
            return false;
        };
        let Some(scope) = Path::new(&self.context.scope, paths) else {
            return false;
        };
        self.package.valid()
            && identity.host_id.len() <= 256
            && !identity.host_id.chars().any(char::is_control)
            && identity.address.len() <= 2048
            && !identity.address.chars().any(char::is_control)
            && Context::authenticated(identity, self.context.scope.clone(), platform)
                == Some(self.context.clone())
            && self.selection.protocol == contracts::PROTOCOL
            && platform.absolute(&self.install_directory)
            && platform.absolute(&self.selection.executable)
            && platform.absolute(&self.selection.directory)
            && install != executable
            && install.parent().is_some()
            && install.contains(&executable)
            && !install.overlaps(&state)
            && state != scope
            && scope.contains(&state)
    }
    fn paths(&self) -> Paths {
        if self.package.platform() == Some(Platform::Windows) {
            Paths::Windows
        } else {
            Paths::Posix
        }
    }
    pub fn same_host(&self, destination: &SessionIdentity) -> bool {
        self.destination.host_id == destination.host_id
            || self.destination.address == destination.address
            || self.destination.server_key == destination.server_key
    }
    pub fn protects(&self, path: &str) -> bool {
        [&self.install_directory, &self.selection.directory]
            .iter()
            .any(|reserved| {
                match (
                    Path::new(reserved, self.paths()),
                    Path::new(path, self.paths()),
                ) {
                    (Some(left), Some(right)) => left.overlaps(&right),
                    _ => true,
                }
            })
    }
    pub fn conflicts(&self, scopes: &[super::super::admission::Scope]) -> bool {
        scopes.iter().any(|scope| {
            self.same_host(&scope.destination)
                && (scope.platform() != Some(self.paths())
                    || scope.paths.iter().any(|path| self.protects(path)))
        })
    }
    pub fn overlaps(&self, other: &Self) -> bool {
        self.same_host(&other.destination)
            && (self.paths() != other.paths()
                || self.protects(&other.install_directory)
                || self.protects(&other.selection.directory))
    }
    pub fn matches(&self, authority: &Authority) -> bool {
        self.package
            .platform()
            .is_some_and(|platform| authority.valid(platform))
            && self.package.matches(authority)
            && authority.context == self.context
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::ssh::files::native_save) enum Stage {
    Reserved,
    Dispatched,
    Ready,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(in crate::ssh::files::native_save) struct Record {
    pub id: String,
    pub journal_id: String,
    pub revision: u64,
    pub owner: Owner,
    pub plan: Plan,
    pub stage: Stage,
    pub authority: Option<Authority>,
}
impl Record {
    pub fn valid(&self) -> bool {
        contracts::uuid(&self.id)
            && contracts::uuid(&self.journal_id)
            && contracts::uuid(&self.owner.id)
            && contracts::uuid(&self.owner.generation)
            && self.plan.valid()
            && match self.stage {
                Stage::Reserved => self.revision == 1 && self.authority.is_none(),
                Stage::Dispatched => self.revision == 2 && self.authority.is_none(),
                Stage::Ready => {
                    self.revision == 3
                        && self
                            .authority
                            .as_ref()
                            .is_some_and(|authority| self.plan.matches(authority))
                }
            }
    }
}
