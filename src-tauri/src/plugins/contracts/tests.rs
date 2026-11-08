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
    let response = describe_api();
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
            } else {
                "0.21.0"
            })
        );
        assert_eq!(
            method.permissions,
            if name == "sessions.list" {
                &["sessions.read"][..]
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
    ] {
        for error in [
            AppError::validation("pluginSecurity.blocked"),
            AppError::validation("pluginSecurity.permissionDenied"),
            AppError::Io(std::io::Error::other("fixture IO failure")),
        ] {
            samples.push(json!({"method":method,"params":{},"inputValid":!method.starts_with("storage."),"error":super::super::host::error_payload(&error)}));
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
