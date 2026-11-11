//! Persist cancellation before touching entries; retries keep the same direction.
use super::*;

pub(in crate::storage) fn cancel(paths: &Paths, config: &mut Config) -> AppResult<()> {
    let Some(mut pending) = config.pending.clone() else {
        return Ok(());
    };
    if uuid::Uuid::parse_str(&pending.id).is_err() {
        return Err(AppError::validation("storage.invalidPlan"));
    }
    if pending.action != config::Action::Cancel {
        let mut next = config.clone();
        pending.action = config::Action::Cancel;
        next.pending = Some(pending.clone());
        config::save(&paths.home, &next)?;
        *config = next;
    }
    for change in &pending.changes {
        let retained = if restore::is_default(paths, change)? {
            restore::cancel(paths, change, &pending.id)?
        } else if owned(&change.target, &pending.id) {
            // Already published copies are not current data. Preserve them in
            // place, including edits, rather than deleting a path after a check.
            Some(change.target.clone())
        } else {
            let staging = stage(change, &pending.id)?;
            owned(&staging, &pending.id).then_some(staging)
        };
        if let Some(path) = retained {
            let mut next = config.clone();
            next.archives.insert(change.category, path);
            config::save(&paths.home, &next)?;
            *config = next;
        }
    }
    let mut next = config.clone();
    next.pending = None;
    next.last_error = None;
    config::save(&paths.home, &next)?;
    *config = next;
    Ok(())
}
