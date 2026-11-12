//! Dedicated keyring service. No host-password/plugin-secret API can address it.
use super::{
    contracts,
    journal::{Error, Result},
};
use keyring::{Entry, Error as KeyringError};

pub(super) trait Secrets: Send + Sync {
    fn create(&self, key: &str, token: &str) -> Result<()>;
    fn load(&self, key: &str) -> Result<String>;
}

pub(super) struct System {
    service: String,
}
impl System {
    /// Pass the actual application identifier, including the isolated QA identifier.
    pub fn new(application: &str) -> Result<Self> {
        if application.is_empty()
            || application.len() > 128
            || !application
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-'))
        {
            return Err(Error::Unrecognized);
        }
        Ok(Self {
            service: format!("{application}.native-file-saves"),
        })
    }
    fn entry(&self, key: &str) -> Result<Entry> {
        let parts: Vec<_> = key.split(':').collect();
        if parts.len() != 3 || parts.iter().any(|part| !contracts::uuid(part)) {
            return Err(Error::Unrecognized);
        }
        Entry::new(&self.service, key).map_err(|_| Error::SecretUnavailable)
    }
}
impl Secrets for System {
    fn create(&self, key: &str, token: &str) -> Result<()> {
        if !contracts::digest(token) || token.bytes().all(|byte| byte == b'0') {
            return Err(Error::SecretChanged);
        }
        let entry = self.entry(key)?;
        match entry.get_password() {
            Ok(existing) if existing == token => return Ok(()),
            Ok(_) => return Err(Error::SecretChanged),
            Err(KeyringError::NoEntry) => (),
            Err(_) => return Err(Error::SecretUnavailable),
        }
        entry
            .set_password(token)
            .map_err(|_| Error::SecretUnavailable)
    }
    fn load(&self, key: &str) -> Result<String> {
        self.entry(key)?.get_password().map_err(|error| {
            if matches!(error, KeyringError::NoEntry) {
                Error::SecretChanged
            } else {
                Error::SecretUnavailable
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn namespace_and_keys_cannot_address_host_or_plugin_credentials() {
        let isolated = System::new(&format!("qa.test.{}", uuid::Uuid::new_v4())).unwrap();
        assert!(isolated.service.ends_with(".native-file-saves"));
        for key in ["host-id", "plugin:example:key", "../escape", "", "a:b:c"] {
            assert!(isolated.entry(key).is_err());
        }
        assert!(System::new("qa\nproduction").is_err());
        // This test never reads or writes any actual keyring entry.
    }
}
