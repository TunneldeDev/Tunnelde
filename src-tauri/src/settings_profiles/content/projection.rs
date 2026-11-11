use crate::{
    error::{AppError, AppResult},
    settings::Settings,
};
use std::sync::Arc;

pub(super) fn text(settings: serde_json::Value) -> AppResult<Arc<str>> {
    // normalize validates native portable values without accepting arbitrary
    // Settings keys, then the public adapter removes private fields explicitly.
    let result = (|| {
        let settings: Settings = serde_json::from_value(super::super::normalize(settings)?)?;
        let values = crate::services::settings::preferences::profile_values(&settings)?;
        let text = serde_json::to_string(&values)?;
        if text.len() > super::MAX_CONTENT_BYTES {
            return Err(AppError::validation("profiles.content.invalidContent"));
        }
        Ok(Arc::from(text))
    })();
    result.map_err(|_: AppError| AppError::validation("profiles.content.invalidContent"))
}
