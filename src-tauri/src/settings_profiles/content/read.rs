use super::{
    cache,
    contracts::{Catalogue, Chunk, Read},
    projection, MAX_RESPONSE_BYTES,
};
use crate::{
    error::{AppError, AppResult},
    settings_profiles::{observation::contracts::Metadata, repository},
};
fn capture(db: &crate::db::Database) -> AppResult<repository::Captured> {
    db.with(|conn| {
        let tx = conn.unchecked_transaction()?;
        let captured = repository::capture(&tx)?;
        tx.commit()?;
        Ok(captured)
    })
}

pub(crate) fn catalogue(
    db: &crate::db::Database,
    check: impl Fn() -> AppResult<()>,
) -> AppResult<Catalogue> {
    check()?;
    let captured = capture(db)?;
    check()?;
    let saved = captured.decode()?;
    let response = Catalogue {
        version: 1,
        revision: saved.revision,
        active_id: saved.active_id,
        items: saved
            .profiles
            .into_iter()
            .map(|p| Metadata {
                id: p.id,
                name: p.name,
                updated_at: p.updated_at,
            })
            .collect(),
    };
    check()?;
    Ok(response)
}

pub(crate) fn read(
    db: &crate::db::Database,
    request: Read,
    check: impl Fn() -> AppResult<()>,
) -> AppResult<Chunk> {
    request.validate()?;
    check()?;
    // All repository rows (including the nonce/selection) share one SQLite read.
    let captured = capture(db)?;
    check()?;
    let saved = captured.decode()?;
    if saved.revision != request.revision {
        return Err(AppError::validation("profiles.conflict"));
    }
    let profile = saved
        .profiles
        .into_iter()
        .find(|p| p.id == request.id)
        .ok_or_else(|| AppError::NotFound("profiles.notFound".into()))?;
    check()?;
    let cached = cache::shared()
        .lock()
        .map_err(|_| AppError::internal("profiles.content.unavailable"))?
        .get(&request.revision, &request.id);
    let text = match cached {
        Some(text) => text,
        None => {
            let text = projection::text(profile.settings)?;
            check()?;
            cache::shared()
                .lock()
                .map_err(|_| AppError::internal("profiles.content.unavailable"))?
                .insert(&request.revision, &request.id, text.clone());
            text
        }
    };
    let chunk = segment(&text, request)?;
    check()?;
    Ok(chunk)
}

pub(super) fn segment(text: &str, request: Read) -> AppResult<Chunk> {
    if request.offset > text.len() || !text.is_char_boundary(request.offset) {
        return Err(AppError::validation("profiles.content.invalidRange"));
    }
    let mut end = text.len().min(request.offset + request.limit);
    loop {
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        let response = Chunk {
            version: 1,
            id: request.id.clone(),
            revision: request.revision.clone(),
            offset: request.offset,
            total_bytes: text.len(),
            text: text[request.offset..end].into(),
            next_offset: (end < text.len()).then_some(end),
        };
        if serde_json::to_vec(&response)?.len() <= MAX_RESPONSE_BYTES {
            return Ok(response);
        }
        // JSON escaping can expand one UTF-8 byte into six wire bytes. Reduce at
        // character boundaries rather than returning a transport-size failure.
        end = request.offset + (end - request.offset) / 2;
    }
}
