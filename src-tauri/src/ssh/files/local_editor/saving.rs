//! Bounded local workers retain publication admission and notifications through settlement.
use super::*;
use crate::services::files::operations::Budget;

pub(crate) struct SaveRequest {
    pub path: String,
    pub content: String,
    pub baseline: Option<String>,
    pub mode: TextSaveMode,
}

impl SaveRequest {
    pub fn new(
        path: String,
        content: String,
        baseline: Option<String>,
        mode: TextSaveMode,
    ) -> Self {
        Self {
            path,
            content,
            baseline,
            mode,
        }
    }
}

pub async fn save(
    app: AppHandle,
    path: String,
    content: String,
    baseline: String,
    mode: TextSaveMode,
) -> AppResult<()> {
    save_checked(
        app,
        SaveRequest::new(path, content, Some(baseline), mode),
        policy::Native,
        || {},
    )
    .await
}

pub(crate) async fn save_checked(
    app: AppHandle,
    request: SaveRequest,
    policy: impl policy::Policy + Send + 'static,
    on_saved: impl FnOnce() + Send + 'static,
) -> AppResult<()> {
    execute(&write::BUDGET, Some(app), request, policy, on_saved).await
}

pub(super) async fn execute(
    budget: &Budget,
    app: Option<AppHandle>,
    request: SaveRequest,
    policy: impl policy::Policy + Send + 'static,
    on_saved: impl FnOnce() + Send + 'static,
) -> AppResult<()> {
    validate_editor_text(
        &request.path,
        &request.content,
        request.baseline.as_deref().unwrap_or_default(),
    )?;
    budget
        .blocking(move |cancellation| {
            let mut on_saved = Some(on_saved);
            let result =
                transaction::save(app.as_ref(), &request, &policy, cancellation, |phase, _| {
                    if phase == "published" {
                        // Publication cannot be undone by dropping the RPC future.
                        // Notify on this worker before fallible staging cleanup.
                        if let Some(on_saved) = on_saved.take() {
                            on_saved();
                        }
                    }
                    Ok(())
                });
            if result.is_ok() {
                // A successful no-op still reconciles a caller's potentially stale view.
                if let Some(on_saved) = on_saved.take() {
                    on_saved();
                }
            }
            result
        })
        .await
}

#[cfg(test)]
pub(in crate::ssh::files) async fn save_without_app(
    path: &str,
    content: &str,
    baseline: &str,
    encoding: TextEncoding,
    bom: bool,
) -> AppResult<()> {
    validate_editor_text(path, content, baseline)?;
    save_transaction_with_mode(
        None,
        path,
        content,
        Some(baseline),
        TextSaveMode::editor(Some(encoding), bom),
        |_, _| Ok(()),
        |_, _| Ok(()),
    )
}

// The stage hook permits tests to inject actual partial writes/failures and
// concurrent filesystem mutations at the production transaction boundaries.
#[cfg(test)]
pub(super) fn save_sync(
    app: Option<&AppHandle>,
    requested: &str,
    content: &str,
    baseline: &str,
    hook: impl FnMut(&str, &Record) -> AppResult<()>,
) -> AppResult<()> {
    save_transaction(app, requested, content, Some(baseline), |_, _| Ok(()), hook)
}

#[cfg(test)]
pub(super) fn save_transaction(
    app: Option<&AppHandle>,
    requested: &str,
    content: &str,
    baseline: Option<&str>,
    check: impl Fn(&Path, &str) -> AppResult<()>,
    hook: impl FnMut(&str, &Record) -> AppResult<()>,
) -> AppResult<()> {
    save_transaction_with_mode(
        app,
        requested,
        content,
        baseline,
        TextSaveMode::editor(None, false),
        check,
        hook,
    )
}

#[cfg(test)]
pub(super) fn save_transaction_with_mode(
    app: Option<&AppHandle>,
    requested: &str,
    content: &str,
    baseline: Option<&str>,
    mode: TextSaveMode,
    check: impl Fn(&Path, &str) -> AppResult<()>,
    hook: impl FnMut(&str, &Record) -> AppResult<()>,
) -> AppResult<()> {
    let (job, _caller) =
        crate::services::files::operations::Cancellation::for_test("editor.saveCancelled");
    transaction::save(
        app,
        &SaveRequest::new(
            requested.into(),
            content.into(),
            baseline.map(str::to_owned),
            mode,
        ),
        &policy::Checked(check),
        &job,
        hook,
    )
}

#[cfg(test)]
pub(super) async fn save_async(
    app: Option<AppHandle>,
    path: String,
    content: String,
    baseline: Option<String>,
    check: impl Fn(&Path, &str) -> AppResult<()> + Send + 'static,
    on_saved: impl FnOnce() + Send + 'static,
) -> AppResult<()> {
    execute(
        &write::BUDGET,
        app,
        SaveRequest::new(path, content, baseline, TextSaveMode::editor(None, false)),
        policy::Checked(check),
        on_saved,
    )
    .await
}

#[cfg(test)]
pub(super) async fn save_with_budget(
    budget: &Budget,
    app: Option<AppHandle>,
    path: String,
    content: String,
    baseline: Option<String>,
    check: impl Fn(&Path, &str) -> AppResult<()> + Send + 'static,
    on_saved: impl FnOnce() + Send + 'static,
) -> AppResult<()> {
    execute(
        budget,
        app,
        SaveRequest::new(path, content, baseline, TextSaveMode::editor(None, false)),
        policy::Checked(check),
        on_saved,
    )
    .await
}
