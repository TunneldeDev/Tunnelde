use super::*;

#[test]
fn stable_core_contracts_preserve_the_frozen_v1_floor() {
    let contracts: Value = serde_json::from_str(CORE_CONTRACTS).unwrap();
    let floor: Value = serde_json::from_str(include_str!(
        "../../../../tests/fixtures/plugin-compat/core-v1.json"
    ))
    .unwrap();
    for (name, contract) in floor["methods"].as_object().unwrap() {
        assert_eq!(
            &contracts["methods"][name], contract,
            "Frozen core contract changed: {name}"
        );
    }
    let status_floor: Value = serde_json::from_str(include_str!(
        "../../../../tests/fixtures/plugin-compat/status-bar-v1.json"
    ))
    .unwrap();
    for (name, contract) in status_floor["methods"].as_object().unwrap() {
        assert_eq!(
            &contracts["methods"][name], contract,
            "Frozen status bar contract changed: {name}"
        );
    }
    let editor_floor: Value = serde_json::from_str(include_str!(
        "../../../../tests/fixtures/plugin-compat/editor-v1.json"
    ))
    .unwrap();
    for (name, contract) in editor_floor["methods"].as_object().unwrap() {
        assert_eq!(
            &contracts["methods"][name], contract,
            "Frozen editor contract changed: {name}"
        );
    }
    let workspace_floor: Value = serde_json::from_str(include_str!(
        "../../../../tests/fixtures/plugin-compat/workspace-v1.json"
    ))
    .unwrap();
    for (name, contract) in workspace_floor["methods"].as_object().unwrap() {
        assert_eq!(
            &contracts["methods"][name], contract,
            "Frozen workspace contract changed: {name}"
        );
    }
    let response = describe_api();
    let logging_floor: Value = serde_json::from_str(include_str!(
        "../../../../tests/fixtures/plugin-compat/logging-v1.json"
    ))
    .unwrap();
    for (name, contract) in logging_floor["methods"].as_object().unwrap() {
        assert_eq!(
            &contracts["methods"][name], contract,
            "Frozen logging contract changed: {name}"
        );
    }
    let ui_floor: Value = serde_json::from_str(include_str!(
        "../../../../tests/fixtures/plugin-compat/ui-v1.json"
    ))
    .unwrap();
    for (name, contract) in ui_floor["methods"].as_object().unwrap() {
        assert_eq!(
            &contracts["methods"][name], contract,
            "Frozen UI contract changed: {name}"
        );
    }
    let tab_bar_floor: Value = serde_json::from_str(include_str!(
        "../../../../tests/fixtures/plugin-compat/tab-bar-v1.json"
    ))
    .unwrap();
    for (name, contract) in tab_bar_floor["methods"].as_object().unwrap() {
        assert_eq!(
            &contracts["methods"][name], contract,
            "Frozen tab bar contract changed: {name}"
        );
    }
    let events_floor: Value = serde_json::from_str(include_str!(
        "../../../../tests/fixtures/plugin-compat/events-v1.json"
    ))
    .unwrap();
    for (name, contract) in events_floor["methods"].as_object().unwrap() {
        assert_eq!(
            &contracts["methods"][name], contract,
            "Frozen event contract changed: {name}"
        );
    }
    for method in response["methods"].as_array().unwrap() {
        assert_eq!(
            method.get("contract").is_some(),
            method["stability"] == "stable"
        );
    }
    for name in contracts["methods"].as_object().unwrap().keys() {
        let method = method_info(name).expect("contract must name an implemented method");
        assert_eq!(method.stability, "stable");
        assert_eq!(
            method.since,
            Some(if name.starts_with("statusBar.") {
                "0.32.0-beta.1"
            } else if name.starts_with("editor.") {
                "0.29.0-beta.2"
            } else if name.starts_with("tabBar.") {
                "0.32.0-beta.6"
            } else {
                "0.21.0"
            })
        );
        assert_eq!(
            method.permissions,
            if name == "sessions.list" {
                &["sessions.read"][..]
            } else if name == "editor.active" {
                &["editor.read"][..]
            } else if name == "editor.replace" {
                &["editor.write"][..]
            } else if name == "workspace.snapshot" {
                &["workspace.read"][..]
            } else if name == "log" {
                &["log"][..]
            } else {
                &[][..]
            }
        );
    }
}

// Export real implementations' responses; the JS checker compiles and validates
// each embedded schema against these, not hand-authored copies of the results.
#[tokio::test]
async fn emit_core_contract_responses() {
    let root =
        std::env::temp_dir().join(format!("tunnelde-core-contract-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&root).unwrap();
    let mut samples = vec![
        json!({"method":"api.describe","params":{},"result":describe_api()}),
        json!({"method":"sessions.list","params":{"future":true},"result":[]}),
        json!({"method":"sessions.list","params":{},"result":encode(vec![PluginSession::from(crate::ssh::SessionInfo {
            id:"session".into(),host_id:"host".into(),title:"测试主机".into(),address:"example.test:22".into(),
            cols:u32::MAX,rows:0,connected_at:123,terminal:true,purpose:None,
        })]).unwrap()}),
    ];
    for value in [
        json!({"文档":[true,42,null]}),
        json!(["你好", false]),
        Value::Null,
        json!(""),
    ] {
        for (method, params) in [
            (
                "storage.set",
                json!({"key":"draft.v1-2_3","value":value,"future":true}),
            ),
            ("storage.get", json!({"key":"draft.v1-2_3"})),
            ("storage.delete", json!({"key":"draft.v1-2_3"})),
            ("storage.get", json!({"key":"draft.v1-2_3"})),
        ] {
            validate_params(&params).unwrap();
            let result = storage_at(&root, "a", method, &params, || Ok(()))
                .await
                .unwrap();
            if method == "storage.set" || method == "storage.delete" {
                assert!(result.is_null());
            }
            samples.push(json!({"method":method,"params":params,"result":result}));
        }
    }
    samples.extend(super::super::status_bar::contract_samples());
    samples.extend(super::super::tab_bar::contract_samples());
    samples.extend(super::super::logging::tests::contract_samples());
    samples.extend(super::super::events::tests::contract_samples());
    for (variable, methods) in [
        (
            "TUNNELDE_EDITOR_CONTRACT_INPUT",
            &["editor.active", "editor.replace"][..],
        ),
        (
            "TUNNELDE_WORKSPACE_CONTRACT_INPUT",
            &["workspace.snapshot"][..],
        ),
        (
            "TUNNELDE_UI_CONTRACT_INPUT",
            &["ui.showMessage", "ui.confirm"][..],
        ),
    ] {
        let Some(path) = std::env::var_os(variable) else {
            continue;
        };
        let frontend: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        for sample in frontend["samples"].as_array().unwrap() {
            assert!(sample["method"]
                .as_str()
                .is_some_and(|name| methods.contains(&name)));
            let mut sample = sample.clone();
            let error = sample.as_object_mut().unwrap().remove("frontendError");
            let value = sample.as_object_mut().unwrap().remove("result");
            // Feed requests through the same outer wire budget before encoding
            // the real frontend result. UTF-16 UI limits do not bypass UTF-8 RPC.
            let result = validate_params(&sample["params"]).and_then(|()| {
                frontend_result(value, error.map(|value| value.as_str().unwrap().to_owned()))
            });
            match result {
                Ok(value) => {
                    sample["result"] = value;
                }
                Err(error) => {
                    sample["error"] = super::super::host::error_payload(&error);
                }
            }
            samples.push(sample);
        }
    }
    // Maximum legal ASCII key and the newline boundary of JSON-schema regexes.
    for key in ["a".repeat(128), "._-".into()] {
        let params = json!({"key":key,"value":123});
        let result = storage_at(&root, "a", "storage.set", &params, || Ok(()))
            .await
            .unwrap();
        samples.push(json!({"method":"storage.set","params":params,"result":result}));
    }
    for params in [
        json!({}),
        json!({"key":1}),
        json!({"key":null}),
        json!({"key":""}),
        json!({"key":"a\n"}),
        json!({"key":"键"}),
        json!({"key":"../x"}),
        json!({"key":"__proto__"}),
        json!({"key":"constructor"}),
        json!({"key":"prototype"}),
        json!({"key":"a".repeat(129)}),
    ] {
        for method in ["storage.get", "storage.set", "storage.delete"] {
            let error = storage_at(&root, "a", method, &params, || Ok(()))
                .await
                .unwrap_err();
            samples.push(json!({"method":method,"params":params,"inputValid":false,"error":super::super::host::error_payload(&error)}));
        }
    }
    let params = json!({"key":"draft"});
    let error = storage_at(&root, "a", "storage.set", &params, || Ok(()))
        .await
        .unwrap_err();
    assert_eq!(error.to_string(), "plugin.api.missing:value");
    samples.push(json!({"method":"storage.set","params":params,"inputValid":false,"error":super::super::host::error_payload(&error)}));
    for method in [
        "api.describe",
        "sessions.list",
        "storage.get",
        "storage.set",
        "storage.delete",
    ] {
        for params in [
            Value::Null,
            json!([]),
            json!(1),
            json!({"key":"draft","value":"文".repeat(MAX_REQUEST / 3)}),
        ] {
            let error = validate_params(&params).unwrap_err();
            samples.push(json!({"method":method,"params":params,"inputValid":params.is_object(),"error":super::super::host::error_payload(&error)}));
        }
    }
    // Bad persistent data and aggregate byte quota are operational errors,
    // even when the request satisfies the structural input schema.
    for bytes in [
        b"[]".to_vec(),
        b"{broken".to_vec(),
        vec![b'x'; MAX_STORAGE + 1],
    ] {
        std::fs::write(storage_path(&root, "corrupt"), bytes).unwrap();
        let params = json!({"key":"draft"});
        let error = storage_at(&root, "corrupt", "storage.get", &params, || Ok(()))
            .await
            .unwrap_err();
        samples.push(json!({"method":"storage.get","params":params,"inputValid":true,"error":super::super::host::error_payload(&error)}));
    }
    let params = json!({"key":"large","value":"x".repeat(MAX_STORAGE)});
    let error = storage_at(&root, "a", "storage.set", &params, || Ok(()))
        .await
        .unwrap_err();
    assert_eq!(error.to_string(), "plugin.api.storageTooLarge");
    samples.push(json!({"method":"storage.set","params":params,"inputValid":true,"error":super::super::host::error_payload(&error)}));
    // Unknown internal routes must not fall through to deletion.
    let params = json!({"key":"sentinel","value":42});
    storage_at(&root, "a", "storage.set", &params, || Ok(()))
        .await
        .unwrap();
    let error = storage_at(&root, "a", "storage.typo", &params, || Ok(()))
        .await
        .unwrap_err();
    assert_eq!(error.to_string(), "plugin.api.unknownMethod");
    assert_eq!(
        storage_at(&root, "a", "storage.get", &params, || Ok(()))
            .await
            .unwrap(),
        json!(42)
    );
    assert_eq!(
        storage_at(&root, "b", "storage.get", &params, || Ok(()))
            .await
            .unwrap(),
        Value::Null
    );
    for (message, code) in [
        ("plugin.api.unknownMethod", -32601),
        ("plugin.api.invalidRequest", -32600),
        ("plugin.api.invalidParams", -32602),
        ("pluginSecurity.permissionDenied", -32001),
        ("plugin.timeout", -32000),
    ] {
        let error = super::super::host::error_payload(&AppError::validation(message));
        assert_eq!(
            error,
            json!({"code":code,"message":message,"data":{"code":"validation"}})
        );
    }
    for method in [
        "api.describe",
        "sessions.list",
        "storage.get",
        "storage.set",
        "storage.delete",
        "editor.active",
        "editor.replace",
        "workspace.snapshot",
    ] {
        for error in [
            AppError::validation("pluginSecurity.blocked"),
            AppError::validation("pluginSecurity.permissionDenied"),
            AppError::Io(std::io::Error::other("fixture IO failure")),
        ] {
            samples.push(json!({"method":method,"params":{},"inputValid":!method.starts_with("storage.") && method != "editor.replace","error":super::super::host::error_payload(&error)}));
        }
    }
    if let Some(path) = std::env::var_os("TUNNELDE_CORE_CONTRACT_OUTPUT") {
        std::fs::write(
            path,
            serde_json::to_vec(&json!({"samples":samples})).unwrap(),
        )
        .unwrap();
    }
    std::fs::remove_dir_all(root).unwrap();
}
