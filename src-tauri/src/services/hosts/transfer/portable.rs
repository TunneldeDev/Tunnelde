//! Secret-bearing payload exists only inside an authenticated envelope or native memory.
use super::*;
use crate::{services::credentials, state::AppState};
use std::path::{Path, PathBuf};
use zeroize::{Zeroize, ZeroizeOnDrop};

const KEY_LIMIT: usize = 1024 * 1024;
// Key bytes are opaque (including encrypted PEM), encoded compactly inside AEAD.
mod key_bytes {
    use base64::{engine::general_purpose::STANDARD, Engine};
    use serde::{Deserialize, Deserializer, Serializer};
    pub fn serialize<S: Serializer>(bytes: &[u8], serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&zeroize::Zeroizing::new(STANDARD.encode(bytes)))
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Vec<u8>, D::Error> {
        let encoded = zeroize::Zeroizing::new(String::deserialize(deserializer)?);
        if encoded.len() > (super::KEY_LIMIT.div_ceil(3) * 4) {
            return Err(serde::de::Error::custom("private key too large"));
        }
        STANDARD
            .decode(encoded.as_bytes())
            .map_err(|_| serde::de::Error::custom("invalid private key encoding"))
    }
}
#[derive(Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct HostSecret {
    pub host_id: String,
    pub password: Option<String>,
    pub key_id: Option<String>,
}
#[derive(Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ProxySecret {
    pub proxy_id: String,
    pub password: String,
}
#[derive(Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
#[serde(deny_unknown_fields)]
pub(super) struct KeySecret {
    pub id: String,
    #[serde(with = "key_bytes")]
    pub content: Vec<u8>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Portable {
    pub document: Document,
    #[serde(default)]
    pub hosts: Vec<HostSecret>,
    #[serde(default)]
    pub proxies: Vec<ProxySecret>,
    #[serde(default)]
    pub keys: Vec<KeySecret>,
}
impl Portable {
    pub fn configuration(document: Document) -> Self {
        Self {
            document,
            hosts: vec![],
            proxies: vec![],
            keys: vec![],
        }
    }
    pub fn has_credentials(&self) -> bool {
        !self.hosts.is_empty() || !self.proxies.is_empty() || !self.keys.is_empty()
    }
    pub fn validate(&self) -> AppResult<()> {
        validate(&self.document)?;
        if self.hosts.len() > 500
            || self.proxies.len() > self.document.proxies.len()
            || self.keys.len() > 500
        {
            return Err(invalid());
        }
        let hosts: HashSet<_> = self.document.hosts.iter().map(|h| h.id.as_str()).collect();
        let proxies: HashSet<_> = self
            .document
            .proxies
            .iter()
            .map(|p| p.id.as_str())
            .collect();
        let keys = unique(self.keys.iter().map(|k| k.id.as_str()))?;
        unique(self.hosts.iter().map(|h| h.host_id.as_str()))?;
        unique(self.proxies.iter().map(|p| p.proxy_id.as_str()))?;
        for host in &self.hosts {
            if !hosts.contains(host.host_id.as_str())
                || host
                    .password
                    .as_ref()
                    .is_some_and(|p| p.is_empty() || p.len() > 4096)
                || host.key_id.as_ref().is_some_and(|id| {
                    !keys.contains(id.as_str())
                        || !self
                            .document
                            .hosts
                            .iter()
                            .any(|h| h.id == host.host_id && h.auth_method == "key")
                })
            {
                return Err(invalid());
            }
        }
        for proxy in &self.proxies {
            if !proxies.contains(proxy.proxy_id.as_str())
                || proxy.password.is_empty()
                || proxy.password.len() > 4096
            {
                return Err(invalid());
            }
        }
        for key in &self.keys {
            if key.content.is_empty()
                || key.content.len() > KEY_LIMIT
                || !self
                    .hosts
                    .iter()
                    .any(|h| h.key_id.as_deref() == Some(&key.id))
            {
                return Err(invalid());
            }
        }
        Ok(())
    }
}

pub(super) fn collect(
    state: &AppState,
    document: Document,
    expected_revision: &str,
) -> AppResult<Portable> {
    let mut payload = Portable::configuration(document);
    if state.db.with(super::revision)? != expected_revision {
        return Err(AppError::validation("hostTransfer.exportChanged"));
    }
    let mut key_paths = HashMap::<PathBuf, String>::new();
    let mut encoded_key_bytes = 0usize;
    for record in &payload.document.hosts {
        let host = state
            .db
            .with(|conn| db::hosts::find_host(conn, &record.id))?;
        let password = credentials::transfer::read_host(state, &host)?;
        let key_id = if host.auth_method == "key" {
            let path = host
                .key_path
                .as_deref()
                .filter(|p| !p.is_empty())
                .ok_or_else(|| AppError::validation("hostTransfer.keyUnavailable"))?;
            let path = std::fs::canonicalize(path)
                .map_err(|_| AppError::validation("hostTransfer.keyUnavailable"))?;
            if let Some(id) = key_paths.get(&path) {
                Some(id.clone())
            } else {
                let mut file = crate::platform::editor_file::open_regular(&path, false)
                    .map_err(|_| AppError::validation("hostTransfer.keyUnavailable"))?;
                let before = file.metadata()?;
                let content =
                    crate::platform::editor_file::read_bounded(&mut file, KEY_LIMIT as u64)?;
                if content.is_empty()
                    || content.len() > KEY_LIMIT
                    || !crate::platform::editor_file::same_metadata(&before, &file.metadata()?)
                {
                    return Err(AppError::validation("hostTransfer.keyUnavailable"));
                }
                encoded_key_bytes += content.len().div_ceil(3) * 4;
                // Reserve space for configuration, passwords, IDs and JSON overhead,
                // and the outer envelope's base64 expansion. Reject before collecting
                // a large batch that could never fit in an export file.
                if encoded_key_bytes > crypto::FILE_LIMIT / 2 {
                    return Err(invalid());
                }
                let id = uuid::Uuid::new_v4().to_string();
                key_paths.insert(path, id.clone());
                payload.keys.push(KeySecret {
                    id: id.clone(),
                    content,
                });
                Some(id)
            }
        } else {
            None
        };
        if password.is_some() || key_id.is_some() {
            payload.hosts.push(HostSecret {
                host_id: host.id,
                password,
                key_id,
            });
        }
    }
    for proxy in &payload.document.proxies {
        if let Some(password) = credentials::read_proxy(state, proxy)? {
            payload.proxies.push(ProxySecret {
                proxy_id: proxy.id.clone(),
                password,
            });
        }
    }
    if state.db.with(super::revision)? != expected_revision {
        return Err(AppError::validation("hostTransfer.exportChanged"));
    }
    payload.validate()?;
    Ok(payload)
}

/// Private directory ownership covers inherited Windows ACLs and Unix 0700.
/// Drop removes only our own uncommitted files, never existing user keys.
pub(super) struct StagedKeys {
    directory: Option<PathBuf>,
    pub paths: HashMap<String, String>,
}
impl Drop for StagedKeys {
    fn drop(&mut self) {
        if let Some(path) = &self.directory {
            let _ = std::fs::remove_dir_all(path);
        }
    }
}
impl StagedKeys {
    pub fn keep(&mut self) {
        self.directory = None;
    }
    pub fn create(root: &Path, payload: &Portable, selected: &HashSet<String>) -> AppResult<Self> {
        use std::io::Write;
        let mut staged = Self {
            directory: None,
            paths: HashMap::new(),
        };
        let needed: HashSet<_> = payload
            .hosts
            .iter()
            .filter(|h| selected.contains(&h.host_id))
            .filter_map(|h| h.key_id.as_deref())
            .collect();
        if needed.is_empty() {
            return Ok(staged);
        }
        std::fs::create_dir_all(root)?;
        let directory = root.join(format!("import-{}", uuid::Uuid::new_v4()));
        crate::platform::editor_file::private_directory(&directory)?;
        staged.directory = Some(directory.clone());
        let mut paths = HashMap::new();
        for key in payload
            .keys
            .iter()
            .filter(|k| needed.contains(k.id.as_str()))
        {
            let path = directory.join(uuid::Uuid::new_v4().to_string());
            let mut options = std::fs::OpenOptions::new();
            options.create_new(true).write(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options.open(&path)?;
            file.write_all(&key.content)?;
            file.sync_all()?;
            paths.insert(key.id.clone(), path.to_string_lossy().into_owned());
        }
        for host in payload
            .hosts
            .iter()
            .filter(|h| selected.contains(&h.host_id))
        {
            if let Some(path) = host.key_id.as_ref().and_then(|id| paths.get(id)) {
                staged.paths.insert(host.host_id.clone(), path.clone());
            }
        }
        Ok(staged)
    }
}
