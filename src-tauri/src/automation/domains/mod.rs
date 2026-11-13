//! Public projections use shared domain services, never internal tab/layout DTOs.
mod forwarding;
mod hosts;
mod logging;
mod preferences;
mod sessions;
use super::contract::{self, Failure};
use crate::state::AppState;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

pub(super) async fn call(app: &AppHandle, method: &str, params: Value) -> Result<Value, Failure> {
    if method.starts_with("preferences.") {
        return preferences::call(app, method, params).await;
    }
    if method.starts_with("logs.") {
        return logging::call(app, method, params).await;
    }
    if method.starts_with("forwards.") {
        return forwarding::call(app, method, params).await;
    }
    if !params.as_object().is_some_and(|fields| fields.is_empty()) {
        return Err(Failure::new(
            "invalid_request",
            "This method accepts an empty params object",
        ));
    }
    let state = app.state::<AppState>();
    match method {
        "api.describe" => Ok(contract::describe()),
        "app.info" => Ok(info(&app.package_info().version.to_string())),
        "hosts.list" => hosts::list(&state.db),
        "sessions.list" => Ok(sessions::project(state.ssh.list())),
        _ => Err(Failure::new(
            "unknown_method",
            "Unknown local API method; use api.describe",
        )),
    }
}

pub(super) fn additional_contracts() -> Vec<Value> {
    let mut methods = preferences::methods();
    methods.push(logging::method());
    methods.push(forwarding::method());
    methods
}

fn info(version: &str) -> Value {
    json!({ "version": version, "apiVersion": contract::VERSION,
        "platform": std::env::consts::OS, "architecture": std::env::consts::ARCH })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn emit_actual_local_api_contracts() {
        let db = crate::db::Database::in_memory().unwrap();
        let input: crate::models::HostInput = serde_json::from_value(
            json!({"name":"Consumer fixture", "host":"example.test", "username":"user"}),
        )
        .unwrap();
        let host = db
            .with(|conn| crate::db::hosts::create_host(conn, &input.validate()?))
            .unwrap();
        let mut samples = json!({"schema":contract::describe(), "samples":[
            {"method":"api.describe", "params":{}, "result":contract::describe()},
            {"method":"app.info", "params":{}, "result":info(env!("CARGO_PKG_VERSION"))},
            {"method":"hosts.list", "params":{}, "result":hosts::list(&db).unwrap()},
            {"method":"sessions.list", "params":{}, "result":sessions::project(vec![crate::ssh::SessionInfo {
                id:"session-fixture".into(),host_id:host.id.clone(),title:"Fixture".into(),address:"user@example.test:22".into(),
                cols:80,rows:24,connected_at:1_700_000_000_000,terminal:true,purpose:None,
            }])}
        ]});
        let mut preference_samples = crate::services::settings::preferences::local_api_samples();
        preference_samples
            .iter_mut()
            .find(|sample| sample["method"] == "preferences.schema")
            .expect("local schema sample")["result"] =
            serde_json::to_value(preferences::describe()).unwrap();
        samples["samples"]
            .as_array_mut()
            .unwrap()
            .extend(preference_samples);
        samples["samples"]
            .as_array_mut()
            .unwrap()
            .extend(logging::tests::samples(&db));
        samples["samples"]
            .as_array_mut()
            .unwrap()
            .extend(forwarding::tests::samples(&db, &host.id));
        assert_eq!(samples["samples"].as_array().unwrap().len(), 10);
        samples["wireSamples"] = json!(crate::automation::transport::contract_samples().await);
        samples["errorSamples"] = contract::describe()["protocol"]["errors"]
            .as_array().unwrap().iter().map(|entry| {
                let error = Failure::new(entry["code"].as_str().unwrap(), "Diagnostic text");
                json!({"exitCode":error.exit_code(),"response":contract::Response::new("fixture".into(),Err(error))})
            }).collect();
        if let Some(path) = std::env::var_os("TUNNELDE_LOCAL_API_OUTPUT") {
            std::fs::write(path, serde_json::to_vec_pretty(&samples).unwrap()).unwrap();
        }
    }
}
