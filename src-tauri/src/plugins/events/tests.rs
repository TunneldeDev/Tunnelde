use super::*;
use serde_json::json;

pub(crate) fn contract_samples() -> Vec<Value> {
    let mut samples = Vec::new();
    for params in [
        json!({"event":"chat"}),
        json!({"event":"task","payload":null}),
        json!({"event":"a".repeat(128),"payload":{"文本":[1,true,null,"😀"]}}),
        json!({"event":"._:-AZaz09","payload":["value"],"future":true}),
        json!({"event":"chat","pluginId":"other","generation":999,"payload":false}),
        json!({"event":"chat","payload":0}),
        json!({"event":"chat","payload":""}),
    ] {
        let mut emitted = Vec::new();
        let result = publish_with("actual-plugin", 7, params.clone(), |event| {
            emitted.push(serde_json::to_value(event)?);
            Ok(())
        })
        .unwrap();
        assert!(result.is_null());
        assert_eq!(emitted.len(), 1);
        assert_eq!(emitted[0]["pluginId"], "actual-plugin");
        assert_eq!(emitted[0]["generation"], 7);
        assert_eq!(emitted[0]["event"], params["event"]);
        assert_eq!(emitted[0]["payload"], params["payload"]);
        samples.push(json!({"method":"events.publish","params":params,"result":result,"emittedEvents":emitted}));
    }
    for params in [
        Value::Null,
        json!([]),
        json!({}),
        json!({"event":null}),
        json!({"event":1}),
        json!({"event":""}),
        json!({"event":"bad\n"}),
        json!({"event":"bad\r"}),
        json!({"event":"bad\u{2028}"}),
        json!({"event":"事件"}),
        json!({"event":"a".repeat(129)}),
        json!({"event":"a/b"}),
    ] {
        let error = publish_with("actual-plugin", 7, params.clone(), |_| {
            panic!("invalid requests must never reach the event transport")
        })
        .unwrap_err();
        samples.push(json!({"method":"events.publish","params":params,"inputValid":false,"error":super::super::host::error_payload(&error),"emittedEvents":[]}));
    }
    for error in [
        AppError::validation("pluginSecurity.blocked"),
        AppError::validation("pluginSecurity.changed"),
        AppError::internal("event transport unavailable"),
    ] {
        let params = json!({"event":"chat","payload":{"ok":true}});
        let error = publish_with("actual-plugin", 7, params.clone(), |_| Err(error)).unwrap_err();
        samples.push(json!({"method":"events.publish","params":params,"error":super::super::host::error_payload(&error),"emittedEvents":[]}));
    }
    // The wire quota counts serialized UTF-8, independently of JSON Schema.
    let params = json!({"event":"chat","payload":"文".repeat(256*1024/3)});
    let error = publish_with("actual-plugin", 7, params.clone(), |_| {
        panic!("oversized requests must never reach the event transport")
    })
    .unwrap_err();
    assert_eq!(error.to_string(), "plugin.api.invalidParams");
    samples.push(json!({"method":"events.publish","params":params,"inputValid":true,"error":super::super::host::error_payload(&error),"emittedEvents":[]}));
    samples
}

#[test]
fn bounded_events_preserve_legacy_defaults_and_host_supplied_identity() {
    assert_eq!(contract_samples().len(), 23);
}

#[test]
fn wire_boundary_includes_event_name_and_json_overhead() {
    let size = 256 * 1024;
    let overhead = serde_json::to_vec(&json!({"event":"x","payload":""}))
        .unwrap()
        .len();
    for (bytes, accepted) in [(size - overhead, true), (size - overhead + 1, false)] {
        let mut delivered = 0;
        let result = publish_with(
            "plugin",
            1,
            json!({"event":"x","payload":"x".repeat(bytes)}),
            |_| {
                delivered += 1;
                Ok(())
            },
        );
        assert_eq!(result.is_ok(), accepted);
        assert_eq!(delivered, usize::from(accepted));
    }
}
