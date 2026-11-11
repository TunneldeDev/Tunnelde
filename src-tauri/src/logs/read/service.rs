use super::{
    contracts::{Batch, Page, Request, Source, MAX_PAGE},
    cursor, diagnostic, operations,
};
use crate::{
    db::Database,
    error::{AppError, AppResult},
};
use std::path::Path;

pub(crate) fn read(
    dir: &Path,
    db: &Database,
    owner: &str,
    request: Request,
    check: impl Fn() -> AppResult<()>,
) -> AppResult<Page> {
    check()?;
    let binding = cursor::binding(owner, &request)?;
    let mut position = cursor::decode(request.cursor.as_deref(), &binding)?;
    let mut batch = Batch::new();
    let (has_more, reset) = match request.source {
        Source::Diagnostics => diagnostic::read(dir, &request, &mut position, &mut batch, &check)?,
        Source::Operations => operations::read(db, &request, &mut position, &mut batch, &check)?,
    };
    check()?;
    let page = Page {
        version: 1,
        source: request.source,
        entries: batch.entries,
        cursor: cursor::encode(position, binding)?,
        has_more,
        reset,
        gap: batch.gap,
    };
    if serde_json::to_vec(&page)?.len() > MAX_PAGE {
        return Err(AppError::validation("logs.read.unavailable"));
    }
    Ok(page)
}
