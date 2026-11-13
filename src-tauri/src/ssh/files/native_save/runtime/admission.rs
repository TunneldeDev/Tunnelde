//! Protect existing native recovery records from legacy mutation entry points.
//! Native setup and saves use the same durable bilateral admission authority.
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
        let claims = service.legacy_claims().await.map_err(errors::app_journal)?;
        let setups: Vec<_> = service
            .setups()
            .await
            .map_err(errors::app_journal)?
            .into_iter()
            .filter(|setup| setup.plan.same_host(destination))
            .collect();
        let blocking: Vec<_> = records
            .iter()
            .filter(|record| record.blocks_target() && record.binding.same_host(destination))
            .collect();
        let legacy: Vec<_> = claims
            .iter()
            .flat_map(|claim| &claim.scopes)
            .filter(|scope| scope.same_host(destination))
            .collect();
        if blocking.is_empty() && legacy.is_empty() && setups.is_empty() {
            return Ok(());
        }
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
        for path in paths {
            if blocking
                .iter()
                .any(|record| record.binding.overlaps_path(path))
                || legacy.iter().any(|scope| overlaps(scope, path))
                || setups.iter().any(|setup| setup.plan.protects(path))
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
                || legacy.iter().any(|scope| overlaps(scope, &resolved))
                || setups.iter().any(|setup| setup.plan.protects(&resolved))
            {
                return Err(AppError::validation("editor.remoteOutcomeUnknown"));
            }
        }
        Ok(())
    }
}

pub(super) async fn resolve(sftp: &SftpSession, path: &str) -> AppResult<String> {
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

fn overlaps(scope: &super::super::journal::admission::Scope, path: &str) -> bool {
    use crate::services::files::admission::Path;
    let Some(platform) = scope.platform() else {
        return true;
    };
    scope.paths.iter().any(|reserved| {
        match (Path::new(reserved, platform), Path::new(path, platform)) {
            (Some(left), Some(right)) => left.overlaps(&right),
            _ => true,
        }
    })
}
