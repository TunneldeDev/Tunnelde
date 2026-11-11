//! Restore defaults entry by entry while retaining incoming data and the journal.
use super::*;

pub(in crate::storage) fn cancel(
    paths: &Paths,
    change: &Change,
    id: &str,
) -> AppResult<Option<PathBuf>> {
    let staging = stage(change, id)?;
    if !pending(change, id)? {
        let preparing = archive(change, id)?.with_extension("preparing");
        if layout::metadata(&preparing)?.is_some() {
            if !owned(&preparing, id) {
                return Err(AppError::validation("storage.verificationFailed"));
            }
            if layout::metadata(&staging)?.is_some() {
                if !owned(&staging, id) {
                    return Err(AppError::validation("storage.verificationFailed"));
                }
                rename_noreplace(&staging, &preparing.join("cancelled"))?;
            }
            return Ok(Some(preparing));
        }
        return if layout::metadata(&staging)?.is_none() {
            Ok(None)
        } else if owned(&staging, id) {
            Ok(Some(staging))
        } else {
            Err(AppError::validation("storage.verificationFailed"))
        };
    }
    let journal = load(paths, change, id)?;
    let directory = archive(change, id)?;
    let retained = directory.join("cancelled");
    let work = match (
        layout::metadata(&staging)?.is_some(),
        layout::metadata(&retained)?.is_some(),
    ) {
        (true, false) if owned(&staging, id) => &staging,
        (false, true) if owned(&retained, id) => &retained,
        _ => return Err(AppError::validation("storage.verificationFailed")),
    };
    // On retry an incoming entry is already in work, and its original may
    // already be back in target. Never confuse that original with incoming data.
    for entry in &journal.installed {
        if layout::metadata(&work.join(entry))?.is_none() {
            verify_installed(paths, change, entry)?;
        }
    }
    for entry in &journal.installed {
        if layout::metadata(&work.join(entry))?.is_none() {
            rename_noreplace(&change.target.join(entry), &work.join(entry))?;
        }
    }
    for entry in &journal.originals {
        let saved = directory.join("original").join(entry);
        let target = change.target.join(entry);
        if layout::metadata(&saved)?.is_some() {
            rename_noreplace(&saved, &target)?;
        } else if layout::metadata(&target)?.is_none() {
            // Missing is not evidence of a successful prior restore.
            return Err(AppError::validation("storage.verificationFailed"));
        }
    }
    if work == &staging {
        rename_noreplace(&staging, &retained)?;
    }
    // No recursive removal: edits made after verification remain recoverable.
    Ok(Some(retained))
}
