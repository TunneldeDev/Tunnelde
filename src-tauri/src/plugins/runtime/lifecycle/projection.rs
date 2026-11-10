use super::{
    contracts::{
        handle::Resource,
        snapshot::{Query, Snapshot},
    },
    identity, MAX_ITEMS, PAGE_BYTES, PAGE_SIZE,
};
use crate::error::{AppError, AppResult};
use sha2::{Digest, Sha256};

pub(super) fn page(items: Vec<Resource>, query: Query) -> AppResult<Snapshot> {
    if items.len() > MAX_ITEMS {
        return Err(AppError::validation("plugin.resources.observationLimit"));
    }
    if query.offset > items.len()
        || (query.offset > 0 && query.revision.is_none())
        || query.revision.as_ref().is_some_and(|v| !identity::valid(v))
    {
        return Err(AppError::validation("plugin.resources.invalidRequest"));
    }
    let revision = format!("{:x}", Sha256::digest(serde_json::to_vec(&items)?));
    if query.revision.as_ref().is_some_and(|v| v != &revision) {
        return Err(AppError::validation("plugin.resources.changed"));
    }
    let total = items.len();
    let items: Vec<_> = items
        .into_iter()
        .skip(query.offset)
        .take(PAGE_SIZE)
        .collect();
    let next = query.offset + items.len();
    let result = Snapshot {
        revision,
        items,
        total,
        next_offset: (next < total).then_some(next),
    };
    if serde_json::to_vec(&result)?.len() > PAGE_BYTES {
        return Err(AppError::validation("plugin.resources.observationLimit"));
    }
    Ok(result)
}

#[cfg(test)]
#[path = "tests/projection.rs"]
mod tests;
