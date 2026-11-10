use crate::{services::plugin_configuration::contracts::document::Snapshot, state::AppState};
use tauri::{AppHandle, Emitter, Manager};

pub(super) fn changed(app: &AppHandle, id: &str, operation: &str, snapshot: &Snapshot) {
    let state = app.state::<AppState>();
    crate::logs::record(&state.db, "plugin.configuration", Some(id));
    tracing::info!(plugin_id=id,operation,revision=%snapshot.revision,"plugin configuration changed");
    // Values are never broadcast to other plugins or written to diagnostics.
    let _ = app.emit("plugin://configuration-changed",serde_json::json!({"pluginId":id,"revision":snapshot.revision,"schemaDigest":snapshot.schema_digest}));
}
