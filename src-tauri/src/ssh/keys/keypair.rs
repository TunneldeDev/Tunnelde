//! Publish one complete managed key without ever replacing another setup's key.
use super::key_error;
use crate::error::{AppError, AppResult};
use russh::keys::{ssh_key::LineEnding, Algorithm, PrivateKey};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

struct Staging {
    path: PathBuf,
    published: bool,
}
impl Drop for Staging {
    fn drop(&mut self) {
        if self.published {
            return;
        }
        if let Err(error) = fs::remove_file(&self.path) {
            tracing::warn!(target: "ssh.keys", stage = "staging-cleanup", reason = %error,
                "Could not remove an owned private-key staging file");
        }
    }
}

#[cfg(test)]
fn ensure_keypair(directory: &Path) -> AppResult<(PathBuf, String)> {
    ensure_with(directory, |_| Ok(()))
}

fn regular(path: &Path) -> AppResult<bool> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_file() => Ok(true),
        Ok(_) => Err(key_error("managed key path is not a regular file")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}

pub(super) fn ensure_with(
    directory: &Path,
    before_publication: impl FnOnce(&Path) -> AppResult<()>,
) -> AppResult<(PathBuf, String)> {
    fs::create_dir_all(directory)?;
    let private = directory.join("tunnelde_ed25519");
    if !regular(&private)? {
        let key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).map_err(key_error)?;
        let pem = key.to_openssh(LineEnding::LF).map_err(key_error)?;
        let staging = directory.join(format!(".tunnelde-key-{}.tmp", uuid::Uuid::new_v4()));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            // Private from creation; there is no world-readable chmod window.
            options.mode(0o600);
        }
        let mut file = options.open(&staging)?;
        let mut staging = Staging {
            path: staging,
            published: false,
        };
        file.write_all(pem.as_bytes())?;
        file.sync_all()?;
        drop(file);
        before_publication(&private)?;
        match crate::platform::file_ops::rename_noreplace(&staging.path, &private) {
            Ok(()) => staging.published = true,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                // Another process published first. Read its complete file;
                // never fall back to an overwriting rename or direct write.
            }
            Err(error) => return Err(key_error(format!("private-key publication: {error}"))),
        }
    }
    if !regular(&private)? {
        return Err(AppError::validation(
            "ssh.keyError: managed key disappeared",
        ));
    }
    let key = russh::keys::load_secret_key(&private, None).map_err(key_error)?;
    let public = key.public_key().to_openssh().map_err(key_error)?;
    Ok((private, public.trim().to_string()))
}

#[cfg(test)]
mod tests;
