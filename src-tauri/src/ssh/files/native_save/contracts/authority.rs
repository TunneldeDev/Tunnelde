use crate::ssh::session::SessionIdentity;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, PartialEq, Eq)]
pub(in super::super) enum Platform {
    Posix,
    Windows,
}
impl Platform {
    pub fn shell(self) -> &'static str {
        match self {
            Self::Posix => "posix",
            Self::Windows => "windows",
        }
    }
    pub fn absolute(self, path: &str) -> bool {
        if path.is_empty() || path.len() > 8192 || path.chars().any(char::is_control) {
            return false;
        }
        match self {
            Self::Posix => path.starts_with('/'),
            // Fixed local paths only, matching the native helper's local-volume contract.
            Self::Windows => {
                let path = path.strip_prefix(r"\\?\").unwrap_or(path);
                let bytes = path.as_bytes();
                bytes.len() >= 3
                    && bytes[0].is_ascii_alphabetic()
                    && bytes[1] == b':'
                    && matches!(bytes[2], b'\\' | b'/')
            }
        }
    }
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(in super::super) struct Context {
    pub host_key: String,
    pub account: String,
    pub scope: String,
}
impl Context {
    pub fn authenticated(
        identity: &SessionIdentity,
        scope: String,
        platform: Platform,
    ) -> Option<Self> {
        // address is captured from the actual connection, never re-read from host settings.
        // A username may itself contain '@'; the final separator precedes the host.
        let (account, destination) = identity.address.rsplit_once('@')?;
        if identity.host_id.is_empty() || destination.is_empty() {
            return None;
        }
        let value = Self {
            host_key: identity.server_key.clone(),
            account: account.into(),
            scope,
        };
        value.valid(platform).then_some(value)
    }
    pub fn valid(&self, platform: Platform) -> bool {
        self.host_key.len() == 50
            && self.host_key.starts_with("SHA256:")
            && self.host_key[7..]
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/'))
            && b"AEIMQUYcgkosw048".contains(self.host_key.as_bytes().last().unwrap_or(&0))
            && !self.account.is_empty()
            && self.account.len() <= 256
            && !self.account.chars().any(char::is_control)
            && platform.absolute(&self.scope)
    }
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(in super::super) struct ObjectIdentity {
    pub platform: String,
    pub device: String,
    pub object: String,
    pub created: String,
}
impl ObjectIdentity {
    pub fn valid(&self, platform: Platform) -> bool {
        let number =
            |v: &str| !v.is_empty() && v.len() <= 40 && v.bytes().all(|b| b.is_ascii_digit());
        let pair = |v: &str| {
            v.split_once(':')
                .is_some_and(|(a, b)| number(a) && number(b))
        };
        number(&self.device)
            && match platform {
                Platform::Posix => {
                    matches!(self.platform.as_str(), "linux" | "macos")
                        && number(&self.object)
                        && number(&self.created)
                }
                Platform::Windows => {
                    self.platform == "windows" && pair(&self.object) && pair(&self.created)
                }
            }
    }
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(in super::super) struct Authority {
    pub authority_id: String,
    pub context: Context,
    pub root: ObjectIdentity,
    pub storage_root: ObjectIdentity,
}
impl Authority {
    pub fn binding(&self) -> String {
        super::json_hash(b"tunnelde.files.save.binding.v1\0", self)
    }
    pub fn valid(&self, platform: Platform) -> bool {
        super::uuid(&self.authority_id)
            && self.context.valid(platform)
            && self.root.valid(platform)
            && self.storage_root.valid(platform)
            && self.root.platform == self.storage_root.platform
    }
}
