//! New staging may join its original location; existing paths cannot relocate it.
use super::*;
use crate::services::files::admission::Path;

pub(super) fn extension(claim: &Claim, resolved: &Scope) -> AppResult<()> {
    let changed = || AppError::validation("editor.nativeChanged");
    let existing: Vec<_> = claim
        .scopes
        .iter()
        .filter(|scope| {
            scope.destination == resolved.destination && scope.platform == resolved.platform
        })
        .collect();
    let platform = existing
        .first()
        .and_then(|scope| scope.platform())
        .ok_or_else(changed)?;
    let roots = claim.transfer_roots.as_ref().ok_or_else(changed)?;
    for pair in resolved.paths.chunks_exact(2) {
        let requested = Path::new(&pair[0], platform).ok_or_else(changed)?;
        let canonical = Path::new(&pair[1], platform).ok_or_else(changed)?;
        let contains = |path: &Path| {
            existing
                .iter()
                .flat_map(|scope| &scope.paths)
                .any(|reserved| {
                    Path::new(reserved, platform).is_some_and(|reserved| reserved.contains(path))
                })
        };
        for root in roots
            .iter()
            .filter(|scope| {
                scope.destination == resolved.destination && scope.platform == resolved.platform
            })
            .flat_map(|scope| scope.paths.chunks_exact(2))
        {
            if Path::new(&root[0], platform).as_ref() == Some(&requested)
                && Path::new(&root[1], platform).as_ref() != Some(&canonical)
            {
                return Err(changed());
            }
        }
        // An already covered spelling is validation, never a request for more
        // authority. A changed symlink cannot add an outside canonical target.
        if contains(&requested) {
            if !contains(&canonical) {
                return Err(changed());
            }
            continue;
        }
        // Staging/backup names may be siblings of an original file or live
        // inside a private sibling directory. Their parent route must preserve
        // the immutable original lexical -> canonical parent correspondence.
        let generated = roots
            .iter()
            .filter(|scope| {
                scope.destination == resolved.destination && scope.platform == resolved.platform
            })
            .flat_map(|scope| scope.paths.chunks_exact(2))
            .any(|root| {
                let route = || -> Option<bool> {
                    let requested_parent = requested.parent()?;
                    let canonical_parent = canonical.parent()?;
                    let original_parent = Path::new(&root[0], platform)?.parent()?;
                    let resolved_parent = Path::new(&root[1], platform)?.parent()?;
                    Some(
                        requested_parent.relative_to(&original_parent)?
                            == canonical_parent.relative_to(&resolved_parent)?,
                    )
                };
                route() == Some(true)
            });
        if !generated {
            return Err(changed());
        }
    }
    if resolved.paths.is_empty() || resolved.paths.len() % 2 != 0 {
        return Err(changed());
    }
    Ok(())
}
