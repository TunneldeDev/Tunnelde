//! Local adapter to the application's public preferences, never internal Settings.
mod schema;
use super::{AppHandle, Failure, Manager, Value};
use crate::{
    error::AppError,
    services::settings::{preferences, writer},
    state::AppState,
};
pub(super) use schema::{describe, methods};

pub(super) async fn call(app: &AppHandle, method: &str, params: Value) -> Result<Value, Failure> {
    let state = app.state::<AppState>();
    let result = match method {
        "preferences.schema" | "preferences.snapshot" => {
            if params.as_object().is_none_or(|fields| !fields.is_empty()) {
                return Err(Failure::new(
                    "invalid_request",
                    "This method accepts an empty params object",
                ));
            }
            if method == "preferences.schema" {
                Ok(serde_json::to_value(describe()))
            } else {
                writer(app, &state)
                    .await
                    .preferences()
                    .map(serde_json::to_value)
            }
        }
        "preferences.update" => {
            let request: preferences::contracts::Update =
                serde_json::from_value(params).map_err(|_| {
                    Failure::new(
                        "invalid_request",
                        "Expected a bounded revision and a changes object",
                    )
                })?;
            let writer = writer(app, &state).await;
            let mut prepared = writer.prepare_preferences(request).map_err(map_error)?;
            // No suspension from persistence through publication: a dropped
            // caller cannot leave committed settings without their UI effects.
            prepared.persist().map_err(map_error)?;
            prepared.finish_preferences().map(serde_json::to_value)
        }
        _ => {
            return Err(Failure::new(
                "unknown_method",
                "Unknown local preferences method",
            ))
        }
    };
    result
        .map_err(map_error)?
        .map_err(|_| Failure::new("internal", "Cannot encode public preferences"))
}

fn map_error(error: AppError) -> Failure {
    match error.original() {
        AppError::Validation(reason) if reason == "preferences.staleRevision" => Failure::new(
            "stale_revision",
            "Preferences changed; read a new snapshot and review the update before retrying",
        ),
        AppError::Validation(reason) if reason.starts_with("preferences.invalidValue:") => {
            Failure::new(
                "invalid_preferences",
                "Changes contain an unknown or invalid preference; check preferences.schema",
            )
        }
        AppError::Validation(_) => Failure::new(
            "operation_rejected",
            "The application cannot apply these preferences in its current state",
        ),
        _ => {
            tracing::error!(target: "automation.preferences", error_code = error.code(), "Public preference operation failed");
            Failure::new(
                "internal",
                "Cannot read or save public preferences; see application logs",
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn local_stability_does_not_promote_the_plugin_adapter() {
        assert_eq!(describe().stability, "stable");
        assert_eq!(preferences::describe().stability, "experimental");
        assert_eq!(describe().groups, preferences::describe().groups);
    }

    #[test]
    fn public_errors_do_not_leak_private_values_or_os_details() {
        assert_eq!(
            map_error(AppError::validation("preferences.staleRevision")).code,
            "stale_revision"
        );
        assert_eq!(
            map_error(AppError::validation(
                "preferences.invalidValue:appearance.theme"
            ))
            .code,
            "invalid_preferences"
        );
        let failure = map_error(AppError::internal("secret database file"));
        assert!(!failure.message.contains("secret"));
    }
}
