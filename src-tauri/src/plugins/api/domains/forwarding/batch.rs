//! Bounded ordered starts; each rule still uses ordinary listener admission.
use super::{authorize, encode, field, start_one, AppError, AppResult, HostContext, Value};
use serde::{Deserialize, Serialize};
use std::{collections::HashSet, future::Future, time::Duration};
use tokio::time::Instant;

const MAX_ITEMS: usize = 16;
const BUDGET: Duration = Duration::from_secs(90);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Target {
    id: String,
    expected_revision: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase", tag = "status")]
enum Outcome {
    Started { id: String },
    Failed { id: String, error: AppError },
    NotStarted { id: String },
}

fn token(value: &str) -> bool {
    !value.is_empty() && value.len() <= 128 && !value.chars().any(char::is_control)
}

fn validate(session_id: &str, items: &[Target]) -> AppResult<()> {
    let mut seen = HashSet::new();
    if !token(session_id)
        || !(1..=MAX_ITEMS).contains(&items.len())
        || items.iter().any(|target| {
            !token(&target.id) || !token(&target.expected_revision) || !seen.insert(&target.id)
        })
    {
        return Err(AppError::validation("forward.invalid"));
    }
    Ok(())
}

async fn run<F: Future<Output = AppResult<()>>>(
    items: Vec<Target>,
    deadline: Instant,
    authorize: impl Fn() -> AppResult<()>,
    mut start: impl FnMut(Target) -> F,
) -> AppResult<Vec<Outcome>> {
    let mut outcomes = Vec::with_capacity(items.len());
    for target in items {
        authorize()?;
        let id = target.id.clone();
        if Instant::now() >= deadline {
            outcomes.push(Outcome::NotStarted { id });
            continue;
        }
        let result = tokio::time::timeout_at(deadline, start(target)).await;
        authorize()?;
        outcomes.push(match result {
            Ok(Ok(())) => Outcome::Started { id },
            Ok(Err(error)) => Outcome::Failed { id, error },
            Err(_) => Outcome::Failed {
                id,
                error: AppError::validation("plugin.timeout"),
            },
        });
    }
    Ok(outcomes)
}

pub(super) async fn start(context: &HostContext, params: Value) -> AppResult<Value> {
    let session_id: String = field(&params, "sessionId")?;
    let items: Vec<Target> = field(&params, "items")?;
    validate(&session_id, &items)?;
    let session_id = session_id.as_str();
    let deadline = Instant::now() + BUDGET;
    encode(
        run(
            items,
            deadline,
            || authorize(context, &["forwards.write"]),
            |target| async move {
                start_one(
                    context,
                    &target.id,
                    session_id,
                    Some(&target.expected_revision),
                    Some(deadline),
                )
                .await
            },
        )
        .await?,
    )
}

#[cfg(test)]
mod tests;
