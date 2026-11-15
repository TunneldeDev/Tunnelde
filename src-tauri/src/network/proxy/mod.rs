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
