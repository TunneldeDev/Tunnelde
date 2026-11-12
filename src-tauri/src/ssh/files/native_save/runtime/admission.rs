//! Protect existing native recovery records from legacy mutation entry points.
//! New native reservations remain test-only: this is not bilateral admission.
use super::*;
use crate::{
    error::{AppError, AppResult},
    ssh::{files::map_sftp, session::SessionIdentity},
};
use russh_sftp::{client::SftpSession, protocol::StatusCode};
#[cfg(test)]
mod tests;

impl Manager {
    pub(crate) async fn writable(
        &self,
        destination: &SessionIdentity,
        sftp: &SftpSession,
        paths: &[&str],
    ) -> AppResult<()> {
        let Some(service) = self.existing().await.map_err(errors::app_journal)? else {
            return Ok(());
        };
        let records = service.records().await.map_err(errors::app_journal)?;
        let blocking: Vec<_> = records
            .iter()
            .filter(|record| record.blocks_target() && record.binding.same_host(destination))
            .collect();
        if blocking.is_empty() {
            return Ok(());
        }
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
        for path in paths {
            if blocking
                .iter()
                .any(|record| record.binding.overlaps_path(path))
            {
                return Err(AppError::validation("editor.remoteOutcomeUnknown"));
            }
            // The lexical path alone cannot establish disjointness: an ancestor
            // symlink may resolve inside the reserved tree. No probe mutates data.
            let resolved = tokio::time::timeout_at(deadline, resolve(sftp, path))
                .await
                .map_err(|_| AppError::validation("editor.nativeReconnect"))??;
            if blocking
                .iter()
                .any(|record| record.binding.overlaps_path(&resolved))
            {
                return Err(AppError::validation("editor.remoteOutcomeUnknown"));
            }
        }
        Ok(())
    }
}

async fn resolve(sftp: &SftpSession, path: &str) -> AppResult<String> {
    if path.len() > 8192 || path.chars().any(char::is_control) {
        return Err(AppError::validation("sftp.absolutePathRequired"));
    }
    let mut candidate = path.to_owned();
    let mut missing: Vec<String> = Vec::new();
    // Bound requests as well as input size. Deep inaccessible/missing trees fail
    // closed instead of launching an unbounded sequence of remote probes.
    for _ in 0..64 {
        match sftp.canonicalize(&candidate).await {
            Ok(mut canonical) => {
                for component in missing.iter().rev() {
                    // SFTP uses '/'. A backslash is a literal POSIX filename
                    // character, so it must never suppress the separator.
                    if !canonical.ends_with('/') {
                        canonical.push('/');
                    }
                    canonical.push_str(component);
                }
                return Ok(canonical);
            }
            Err(russh_sftp::client::error::Error::Status(status))
                if status.status_code == StatusCode::NoSuchFile =>
            {
                let trimmed = candidate.trim_end_matches('/');
                let (parent, component) = trimmed
                    .rsplit_once('/')
                    .filter(|(_, component)| !matches!(*component, "" | "." | ".."))
                    .ok_or_else(|| AppError::validation("editor.nativeChanged"))?;
                missing.push(component.to_owned());
                candidate = if parent.is_empty() { "/" } else { parent }.to_owned();
            }
            Err(error) => return Err(map_sftp(error)),
        }
    }
    Err(AppError::validation("editor.nativeChanged"))
}
