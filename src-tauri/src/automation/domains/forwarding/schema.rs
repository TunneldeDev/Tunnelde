pub(in super::super) fn method() -> serde_json::Value {
    serde_json::from_str(include_str!("schema.json")).expect("checked local forwarding schema")
}
