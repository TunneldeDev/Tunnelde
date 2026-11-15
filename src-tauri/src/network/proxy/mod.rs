//! Separate pure route validation from credential resolution.
use super::{authority, selection, NetworkSettings, ProxyProfile, Vault};
use crate::error::{AppError, AppResult};

// No Debug/Serialize: even a pre-credential URL contains proxy identity.
enum Configured<'a> {
    System,
    Direct,
    Profile(&'a ProxyProfile, reqwest::Url),
}
impl<'a> Configured<'a> {
    fn capture(
        settings: &'a NetworkSettings,
        feature: &str,
        override_value: Option<&str>,
    ) -> AppResult<Self> {
        let chosen = selection(settings, feature, override_value);
        match chosen {
            "system" => return Ok(Self::System),
            "direct" => return Ok(Self::Direct),
            _ => {}
        }
        let profile = settings
            .profiles
            .iter()
            .find(|p| p.id == chosen)
            .ok_or_else(|| AppError::validation("network.proxyMissing"))?;
        let scheme = if profile.protocol == "socks5" {
            "socks5h"
        } else {
            "http"
        };
        let mut url = reqwest::Url::parse(&format!(
            "{scheme}://{}:{}",
            authority(&profile.host),
            profile.port,
        ))
        .map_err(|_| AppError::validation("network.invalid"))?;
        if !profile.username.is_empty() {
            url.set_username(&profile.username)
                .map_err(|_| AppError::validation("network.invalid"))?;
        }
        Ok(Self::Profile(profile, url))
    }

    fn resolve(
        self,
        load: impl FnOnce(&str) -> AppResult<Option<String>>,
    ) -> AppResult<Option<String>> {
        match self {
            Self::System => Ok(None),
            Self::Direct => Ok(Some(String::new())),
            Self::Profile(profile, mut url) => {
                if !profile.username.is_empty() {
                    let password = load(&format!("proxy:{}", profile.id))?.unwrap_or_default();
                    url.set_password(Some(&password))
                        .map_err(|_| AppError::validation("network.invalid"))?;
                }
                Ok(Some(url.to_string()))
            }
        }
    }
}

pub(super) fn validate_selection(
    settings: &NetworkSettings,
    feature: &str,
    override_value: Option<&str>,
) -> AppResult<()> {
    Configured::capture(settings, feature, override_value).map(|_| ())
}

pub fn url(
    vault: &Vault,
    settings: &NetworkSettings,
    feature: &str,
    override_value: Option<&str>,
) -> AppResult<Option<String>> {
    Configured::capture(settings, feature, override_value)?.resolve(|key| vault.load(key))
}

#[cfg(test)]
mod tests;

/// Pure effective configuration; unrelated profiles and display names are excluded.
/// No serialization/debug surface: this is native admission metadata only.
#[derive(Clone, PartialEq, Eq)]
pub(crate) enum Selected {
    System,
    Direct,
    Profile {
        id: String,
        protocol: String,
        host: String,
        port: u16,
        username: String,
    },
}
impl Selected {
    pub(crate) fn capture(
        settings: &NetworkSettings,
        feature: &str,
        value: Option<&str>,
    ) -> AppResult<Self> {
        Ok(match Configured::capture(settings, feature, value)? {
            Configured::System => Self::System,
            Configured::Direct => Self::Direct,
            Configured::Profile(p, _) => Self::Profile {
                id: p.id.clone(),
                protocol: p.protocol.clone(),
                host: p.host.clone(),
                port: p.port,
                username: p.username.clone(),
            },
        })
    }
    pub(crate) fn update_review(&self, digest: &mut sha2::Sha256) {
        use sha2::Digest;
        let fields = match self {
            Self::System => vec!["system".to_owned()],
            Self::Direct => vec!["direct".to_owned()],
            Self::Profile {
                id,
                protocol,
                host,
                port,
                username,
            } => vec![
                "profile".to_owned(),
                id.clone(),
                protocol.clone(),
                host.clone(),
                port.to_string(),
                username.clone(),
            ],
        };
        for field in fields {
            digest.update((field.len() as u64).to_le_bytes());
            digest.update(field.as_bytes());
        }
    }
}
