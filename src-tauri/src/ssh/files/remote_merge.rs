//! Same-server directory merges use rename, never a download/upload or a
//! recursive source deletion. A plan catches structural conflicts before the
//! first mutation; execution can still partially complete on server failures.
use super::*;
use std::collections::HashSet;

const MAX_STEPS: usize = 100_000;
const MAX_DEPTH: usize = 128;

enum Step {
    Move {
        from: String,
        to: String,
        kind: u32,
        replace: bool,
    },
    RemoveEmpty {
        from: String,
        to: String,
    },
}

pub(super) struct Plan {
    steps: Vec<Step>,
    pub needs_replacement: bool,
}

fn changed() -> AppError {
    AppError::validation("sftp.mergePathsChanged")
}

async fn kind(sftp: &SftpSession, path: &str) -> AppResult<Option<u32>> {
    match sftp.symlink_metadata(path).await {
        Ok(metadata) => match metadata.permissions.map(|mode| mode & 0o170000) {
            Some(mode @ (0o040000 | 0o100000 | 0o120000)) => Ok(Some(mode)),
            _ => Err(AppError::validation("sftp.fileMetadataMissing")),
        },
        Err(russh_sftp::client::error::Error::Status(status))
            if status.status_code == StatusCode::NoSuchFile =>
        {
            Ok(None)
        }
        Err(error) => Err(map_sftp(error)),
    }
}

// This detects observable path substitutions; SFTP has no directory-handle
// relative rename and cannot make check + rename atomic against another writer.
async fn directory(sftp: &SftpSession, path: &str) -> AppResult<()> {
    if kind(sftp, path).await? != Some(0o040000)
        || sftp.canonicalize(path).await.map_err(map_sftp)? != path
    {
        return Err(changed());
    }
    Ok(())
}

fn parent(path: &str) -> &str {
    match path.rsplit_once('/') {
        Some(("", _)) => "/",
        Some((value, _)) => value,
        None => ".",
    }
}

impl Plan {
    pub async fn prepare(sftp: &SftpSession, from: &str, to: &str) -> AppResult<Self> {
        if from == to
            || from.starts_with(&format!("{}/", to.trim_end_matches('/')))
            || to.starts_with(&format!("{}/", from.trim_end_matches('/')))
        {
            return Err(AppError::validation("sftp.samePath"));
        }
        let mut plan = Self {
            steps: Vec::new(),
            needs_replacement: false,
        };
        let mut pending = vec![(from.to_owned(), to.to_owned(), 0, false)];
        while let Some((from, to, depth, visited)) = pending.pop() {
            if plan.steps.len() + pending.len() >= MAX_STEPS || depth > MAX_DEPTH {
                return Err(AppError::validation("sftp.mergeTooLarge"));
            }
            if visited {
                plan.steps.push(Step::RemoveEmpty { from, to });
                continue;
            }
            let source = kind(sftp, &from).await?.ok_or_else(changed)?;
            let destination = kind(sftp, &to).await?;
            if destination.is_some_and(|mode| (mode == 0o040000) != (source == 0o040000)) {
                return Err(AppError::validation("sftp.typeConflict"));
            }
            if source == 0o040000 && destination == Some(0o040000) {
                directory(sftp, &from).await?;
                directory(sftp, &to).await?;
                pending.push((from.clone(), to.clone(), depth, true));
                let mut names = HashSet::new();
                for entry in sftp.read_dir(&from).await.map_err(map_sftp)? {
                    let name = entry.file_name();
                    if name.is_empty()
                        || name == "."
                        || name == ".."
                        || name.contains(['/', '\0'])
                        || !names.insert(name.clone())
                    {
                        return Err(changed());
                    }
                    if plan.steps.len() + pending.len() >= MAX_STEPS {
                        return Err(AppError::validation("sftp.mergeTooLarge"));
                    }
                    pending.push((
                        join_remote(&from, &name),
                        join_remote(&to, &name),
                        depth + 1,
                        false,
                    ));
                }
            } else {
                let replace = destination.is_some();
                plan.needs_replacement |= replace;
                plan.steps.push(Step::Move {
                    from,
                    to,
                    kind: source,
                    replace,
                });
            }
        }
        Ok(plan)
    }

    pub async fn apply(
        self,
        sftp: &SftpSession,
        replacement: Option<&remote_commit::Replacement>,
    ) -> AppResult<()> {
        // Negotiate before any move, including when a conflicting file occurs
        // late in a tree. An unsupported server must leave everything untouched.
        if self.needs_replacement && replacement.is_none() {
            return Err(AppError::validation("sftp.overwriteUnsupported"));
        }
        for step in self.steps {
            match step {
                Step::Move {
                    from,
                    to,
                    kind: expected,
                    replace,
                } => {
                    directory(sftp, parent(&from)).await?;
                    directory(sftp, parent(&to)).await?;
                    if kind(sftp, &from).await? != Some(expected) {
                        return Err(changed());
                    }
                    let target = kind(sftp, &to).await?;
                    if target == Some(0o040000) {
                        return Err(changed());
                    }
                    if replace {
                        replacement.ok_or_else(changed)?.replace(&from, &to).await?;
                    } else {
                        if target.is_some() {
                            return Err(AppError::validation("sftp.alreadyExists"));
                        }
                        rename::entry(sftp, &from, &to).await?;
                    }
                }
                Step::RemoveEmpty { from, to } => {
                    directory(sftp, &from).await?;
                    directory(sftp, &to).await?;
                    sftp.remove_dir(&from)
                        .await
                        .map_err(|error| rename::failure(&from, &to, error))?;
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests;
