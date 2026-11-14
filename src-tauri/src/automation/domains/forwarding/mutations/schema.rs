use serde_json::{json, Value};

pub(in super::super::super) fn methods() -> Vec<Value> {
    let token = json!({"type":"string","minLength":1,"maxLength":128,"x-maxBytes":128,"pattern":r"^[^\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]+$"});
    let endpoint = json!({"type":"object","additionalProperties":false,"required":["host","port"],"properties":{
        "host":{"type":"string","minLength":1,"maxLength":253,"x-maxBytes":253,"pattern":r"^[^\s\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069/\\@?#\[\]]+$"},
        "port":{"type":"integer","minimum":1,"maximum":65535}
    }});
    ["save", "remove", "stop"].into_iter().map(|action| {
        let input = if action == "save" {
            json!({"type":"object","additionalProperties":false,"required":["id","hostId","name","revision","direction","bind","target"],"properties":{
                "id":token,"hostId":token,"name":{"type":"string","minLength":1,"maxLength":120,"x-maxBytes":120,"pattern":r"^[^\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]*\S[^\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]*$"},
                "revision":{"anyOf":[token,{"type":"null"}]},"direction":{"enum":["local","remote"]},"bind":endpoint,"target":endpoint
            },"if":{"properties":{"revision":{"type":"null"}}},"then":{"properties":{"id":{"pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"}}}})
        } else {
            json!({"type":"object","additionalProperties":false,"required":["id","revision"],"properties":{"id":token,"revision":token}})
        };
        let outcome = match action { "save" => "saved", "remove" => "removed", _ => "stopped" };
        json!({"name":format!("forwards.{action}"),"effect":"write","stability":"experimental","since":null,
            "executionTimeoutMs":135_000,"confirmationTimeoutMs":120_000,
            "inputSchema":input,
            "resultSchema":{"type":"object","additionalProperties":false,"required":["outcome","id","revision"],"properties":{
                "outcome":{"enum":[outcome,"dismissed"]},"id":token,"revision":{"anyOf":[token,{"type":"null"}]}
            }},"errors":["invalid_request","stale_revision","operation_rejected"],
            "description":"Request native user confirmation, then conditionally mutate the exact rule. Save never starts a connection. Creation requires a caller-generated canonical lowercase UUID and revision:null; existing IDs are never overwritten by creation. Editing/removing requires the observed revision and a stopped rule. Stop binds the running instance observed before confirmation and will not stop a replacement. One local forwarding dialog at a time; 120s consent expiry. Use the supplied CLI or allow 150s for a full exchange; request framing/authentication remains bounded at10s. Denial returns dismissed. Lost replies/timeouts are uncertain: inspect forwards.list, never blindly retry. These calls do not identify or authenticate a particular local program beyond possession of the local capability. Stop cleanup survives caller cancellation; a cleanup failure does not imply no side effect. No SSH session, runtime ID, credentials or trust bypass are accepted."
        })
    }).collect()
}
