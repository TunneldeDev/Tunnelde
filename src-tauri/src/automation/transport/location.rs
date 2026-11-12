//! The public pointer contains only a path; the capability lives in a private directory.
use super::*;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

pub(super) struct Registration {
    root: PathBuf,
    pointer: PathBuf,
    pointer_bytes: Vec<u8>,
}
impl Registration {
    pub fn create(data: &Path, endpoint: &Endpoint) -> std::io::Result<Self> {
        let root = data.join(format!("automation-{}", uuid::Uuid::new_v4()));
        crate::platform::editor_file::private_directory(&root)?;
        let mut registration = Self {
            root,
            pointer: data.join("automation.json"),
            pointer_bytes: Vec::new(),
        };
        let endpoint_path = registration.root.join("endpoint.json");
        let mut file = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&endpoint_path)?;
        file.write_all(&serde_json::to_vec(endpoint)?)?;
        // Single-instance startup owns this pointer. Publish a complete file and
        // unlink the previous entry rather than following a stale symlink.
        registration.pointer_bytes =
            serde_json::to_vec(&serde_json::json!({"endpoint": endpoint_path}))?;
        let prepared = registration.root.join("pointer.json");
        std::fs::write(&prepared, &registration.pointer_bytes)?;
        match std::fs::remove_file(&registration.pointer) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        crate::platform::file_ops::rename_noreplace(&prepared, &registration.pointer)?;
        Ok(registration)
    }
}
impl Drop for Registration {
    fn drop(&mut self) {
        if std::fs::read(&self.pointer).is_ok_and(|bytes| bytes == self.pointer_bytes) {
            let _ = std::fs::remove_file(&self.pointer);
        }
        let _ = std::fs::remove_file(self.root.join("endpoint.json"));
        let _ = std::fs::remove_file(self.root.join("pointer.json"));
        let _ = std::fs::remove_dir(&self.root);
    }
}

pub(crate) fn read(pointer: &Path) -> Result<Endpoint, Failure> {
    fn bounded(path: &Path) -> std::io::Result<Vec<u8>> {
        let mut bytes = Vec::new();
        crate::platform::regular_file::open_read(path)?
            .take(4097)
            .read_to_end(&mut bytes)?;
        if bytes.len() > 4096 {
            return Err(std::io::ErrorKind::InvalidData.into());
        }
        Ok(bytes)
    }
    let unavailable = || {
        Failure::new("unavailable", "Cannot locate the running application. Start Tunnelde, or use --endpoint with its automation.json path")
    };
    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Pointer {
        endpoint: PathBuf,
    }
    let pointer_data: Pointer =
        serde_json::from_slice(&bounded(pointer).map_err(|_| unavailable())?)
            .map_err(|_| unavailable())?;
    let endpoint: Endpoint =
        serde_json::from_slice(&bounded(&pointer_data.endpoint).map_err(|_| unavailable())?)
            .map_err(|_| unavailable())?;
    if endpoint.version != VERSION
        || !endpoint.address.ip().is_loopback()
        || endpoint.address.port() == 0
        || endpoint.token.len() != 64
    {
        return Err(Failure::new(
            "invalid_request",
            "Invalid local endpoint descriptor",
        ));
    }
    Ok(endpoint)
}

pub(crate) fn default_pointer() -> Option<PathBuf> {
    #[cfg(windows)]
    let root = std::env::var_os("APPDATA").map(PathBuf::from);
    #[cfg(target_os = "macos")]
    let root = std::env::var_os("HOME")
        .map(|home| PathBuf::from(home).join("Library/Application Support"));
    #[cfg(not(any(windows, target_os = "macos")))]
    let root = std::env::var_os("XDG_DATA_HOME")
        .filter(|path| Path::new(path).is_absolute())
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/share")));
    root.map(|root| root.join("dev.tunnelde.app/automation.json"))
}
