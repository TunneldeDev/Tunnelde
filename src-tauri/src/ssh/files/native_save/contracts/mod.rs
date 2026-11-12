pub(super) mod authority;
pub(super) mod operation;
pub(super) mod receipt;
pub(super) const PROTOCOL: &str = "files.save.v1";
pub(super) const MAX_TEXT: usize = 2 * 1024 * 1024;
pub(super) const MAX_PACKET: usize = MAX_TEXT * 6 + 32768;
pub(super) const MAX_OUTPUT: usize = 32768;

pub(super) fn uuid(value: &str) -> bool {
    uuid::Uuid::parse_str(value)
        .is_ok_and(|id| !id.is_nil() && id.hyphenated().to_string() == value)
}
pub(super) fn digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
pub(super) fn hash(domain: &[u8], data: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hash = Sha256::new();
    hash.update(domain);
    hash.update(data);
    format!("{:x}", hash.finalize())
}
pub(super) fn json_hash(domain: &[u8], value: &impl serde::Serialize) -> String {
    fn sort(value: &mut serde_json::Value) {
        match value {
            serde_json::Value::Object(map) => {
                for item in map.values_mut() {
                    sort(item);
                }
                map.sort_keys();
            }
            serde_json::Value::Array(items) => items.iter_mut().for_each(sort),
            _ => (),
        }
    }
    // Only closed, infallibly serializable structs are passed here.
    let mut value = serde_json::to_value(value).expect("closed file-save contract");
    sort(&mut value);
    hash(domain, &serde_json::to_vec(&value).expect("JSON value"))
}
