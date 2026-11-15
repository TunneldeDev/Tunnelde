//! Application-owned OS credentials. The production identifier preserves the
//! historical service and keys; isolated applications never fall back to it.
use keyring::{Entry, Error as KeyringError};

use crate::error::{AppError, AppResult};

pub(crate) struct Vault {
    service: String,
}

impl Vault {
    pub(crate) fn new(application: &str) -> AppResult<Self> {
        if application.is_empty()
            || application.len() > 128
            || !application
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-'))
        {
            return Err(AppError::validation("vault.invalidApplication"));
        }
        Ok(Self {
            service: application.to_owned(),
        })
    }

    fn entry(&self, host_id: &str) -> AppResult<Entry> {
        Entry::new(&self.service, host_id)
            .map_err(|error| AppError::Ssh(format!("vault.unavailable: {error}")))
    }

    pub(crate) fn save(&self, host_id: &str, password: &str) -> AppResult<()> {
        self.entry(host_id)?
            .set_password(password)
            .map_err(|error| AppError::Ssh(format!("vault.save: {error}")))
    }

    pub(crate) fn load(&self, host_id: &str) -> AppResult<Option<String>> {
        match self.entry(host_id)?.get_password() {
            Ok(password) => Ok(Some(password)),
            Err(KeyringError::NoEntry) => Ok(None),
            Err(error) => Err(AppError::Ssh(format!("vault.load: {error}"))),
        }
    }

    pub(crate) fn forget(&self, host_id: &str) -> AppResult<()> {
        match self.entry(host_id)?.delete_credential() {
            Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
            Err(error) => Err(AppError::Ssh(format!("vault.forget: {error}"))),
        }
    }

    #[cfg(test)]
    pub(crate) fn has(&self, host_id: &str) -> AppResult<bool> {
        Ok(self.load(host_id)?.is_some())
    }
}

#[cfg(test)]
mod tests;
