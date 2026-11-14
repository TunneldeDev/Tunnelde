use serde_json::{json, Value};
pub(in super::super) fn methods() -> Vec<Value> {
    let token = json!({"type":"string","minLength":1,"maxLength":128,"x-maxBytes":128,"pattern":r"^[^\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]+$"});
    let uuid = json!({"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"});
    let query = json!({"type":"object","additionalProperties":false,"required":["requestId"],"properties":{"requestId":uuid}});
    let receipt = json!({"type":"object","additionalProperties":false,"required":["id","revision","requestId","phase","expiresAt","error"],"properties":{
        "id":token,"revision":token,"requestId":uuid,
        "phase":{"enum":["consent","credentials","connecting","preparing","running","dismissed","cancelled","expired","failed"]},
        "expiresAt":{"type":"integer"},"error":{"anyOf":[{"enum":["forward.startExpired","forward.startUiChanged","ssh.connectionChanged"]},{"type":"null"}]}
    }});
    ["start", "startStatus", "cancelStart"].into_iter().map(|action| json!({
        "name":format!("forwards.{action}"),"effect":if action=="startStatus" {"read"}else{"write"},"stability":"experimental","since":null,
        "inputSchema":if action=="start" {json!({"type":"object","additionalProperties":false,"required":["id","revision","requestId"],"properties":{"id":token,"revision":token,"requestId":uuid}})}else{query.clone()},
        "resultSchema":receipt,"errors":["invalid_request","stale_revision","operation_rejected"],
        "description":"Bounded asynchronous forwarding startup. Start accepts the exact saved rule revision and a caller-generated canonical lowercase UUID; credentials and trust are handled only in the main application after native destination consent. A successful call is a receipt, NOT proof that forwarding is running. Poll startStatus; phase running records successful admission, while forwards.list reports current runtime health. One pending interaction; 300s total deadline, 120s native consent, 15s UI heartbeat expiry. Reload/UI loss/cancel revokes pending work; cancelStart never stops an admitted instance. Same UUID and identical input replays its receipt; differing input is rejected. Terminal receipts retained 15min, maximum128; new requests rejected rather than evicting unexpired receipts. Receipts do not survive application restart. Unknown receipt does not prove absence of side effects: inspect forwards.list, use a NEW UUID, never reuse an unknown one. Trust committed before cancellation is retained. No credentials, session IDs, plugin scope or trust bypass accepted. Possession of the local capability does not identify an individual calling program."
    })).collect()
}
