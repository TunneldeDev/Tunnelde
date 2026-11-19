//! Versioned, authenticated file envelope. Never accept attacker-chosen KDF costs.
use super::*;
use argon2::{Algorithm, Argon2, Params, Version};
use base64::{engine::general_purpose::STANDARD, Engine};
use chacha20poly1305::{
    aead::{Aead, KeyInit, Payload},
    XChaCha20Poly1305, XNonce,
};
use rand::RngExt;
use zeroize::Zeroizing;

pub(super) const FILE_LIMIT: usize = 64 * 1024 * 1024;
const FORMAT: &str = "tunnelde-hosts-encrypted";
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Header {
    format: String,
    version: u32,
    kdf: String,
    memory_kib: u32,
    iterations: u32,
    parallelism: u32,
    cipher: String,
    salt: String,
    nonce: String,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Envelope {
    header: Header,
    ciphertext: String,
}
fn key(password: &str, salt: &[u8]) -> AppResult<Zeroizing<[u8; 32]>> {
    if password.is_empty() || password.len() > 4096 {
        return Err(AppError::validation("hostTransfer.passwordRequired"));
    }
    let mut key = Zeroizing::new([0u8; 32]);
    Argon2::new(
        Algorithm::Argon2id,
        Version::V0x13,
        Params::new(65536, 3, 1, Some(32)).map_err(|_| invalid())?,
    )
    .hash_password_into(password.as_bytes(), salt, key.as_mut())
    .map_err(|_| invalid())?;
    Ok(key)
}
pub(super) fn encrypt(bytes: &[u8], password: &str) -> AppResult<Vec<u8>> {
    if bytes.len() > FILE_LIMIT {
        return Err(invalid());
    }
    let salt: [u8; 16] = rand::rng().random();
    let nonce: [u8; 24] = rand::rng().random();
    let header = Header {
        format: FORMAT.into(),
        version: 1,
        kdf: "argon2id".into(),
        memory_kib: 65536,
        iterations: 3,
        parallelism: 1,
        cipher: "xchacha20-poly1305".into(),
        salt: STANDARD.encode(salt),
        nonce: STANDARD.encode(nonce),
    };
    let key = key(password, &salt)?;
    let ciphertext = XChaCha20Poly1305::new_from_slice(key.as_ref())
        .map_err(|_| invalid())?
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: bytes,
                aad: &serde_json::to_vec(&header)?,
            },
        )
        .map_err(|_| invalid())?;
    let output = serde_json::to_vec(&Envelope {
        header,
        ciphertext: STANDARD.encode(ciphertext),
    })?;
    if output.len() > FILE_LIMIT {
        return Err(invalid());
    }
    Ok(output)
}
pub(super) fn parse(bytes: &[u8]) -> AppResult<Envelope> {
    if bytes.len() > FILE_LIMIT {
        return Err(invalid());
    }
    let envelope: Envelope = serde_json::from_slice(bytes).map_err(|_| invalid())?;
    let h = &envelope.header;
    if h.format != FORMAT
        || h.version != 1
        || h.kdf != "argon2id"
        || h.cipher != "xchacha20-poly1305"
        || h.memory_kib != 65536
        || h.iterations != 3
        || h.parallelism != 1
        || h.salt.len() != 24
        || h.nonce.len() != 32
        || STANDARD.decode(&h.salt).map_err(|_| invalid())?.len() != 16
        || STANDARD.decode(&h.nonce).map_err(|_| invalid())?.len() != 24
        || envelope.ciphertext.len() < 24
        || envelope.ciphertext.len() > FILE_LIMIT
    {
        return Err(invalid());
    }
    Ok(envelope)
}
pub(super) fn decrypt(envelope: &Envelope, password: &str) -> AppResult<Zeroizing<Vec<u8>>> {
    let salt = STANDARD
        .decode(&envelope.header.salt)
        .map_err(|_| invalid())?;
    let nonce = STANDARD
        .decode(&envelope.header.nonce)
        .map_err(|_| invalid())?;
    let key = key(password, &salt)?;
    let ciphertext = STANDARD
        .decode(&envelope.ciphertext)
        .map_err(|_| invalid())?;
    let bytes = XChaCha20Poly1305::new_from_slice(key.as_ref())
        .map_err(|_| invalid())?
        .decrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: &ciphertext,
                aad: &serde_json::to_vec(&envelope.header)?,
            },
        )
        .map_err(|_| AppError::validation("hostTransfer.decryptFailed"))?;
    if bytes.len() > FILE_LIMIT {
        return Err(invalid());
    }
    Ok(Zeroizing::new(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn authenticated_randomized_roundtrip() {
        let a = encrypt(b"private secret", "密码 test").unwrap();
        let b = encrypt(b"private secret", "密码 test").unwrap();
        assert_ne!(a, b);
        assert!(!String::from_utf8_lossy(&a).contains("private secret"));
        let mut envelope = parse(&a).unwrap();
        assert_eq!(
            decrypt(&envelope, "密码 test").unwrap().as_slice(),
            b"private secret"
        );
        assert!(decrypt(&envelope, "wrong").is_err());
        envelope.header.salt = STANDARD.encode([1u8; 16]);
        assert!(decrypt(&envelope, "密码 test").is_err());
    }
    #[test]
    fn rejects_hostile_parameters_before_derivation() {
        let raw = encrypt(b"{}", "password").unwrap();
        for (field, value) in [
            ("memoryKib", serde_json::json!(u32::MAX)),
            ("version", serde_json::json!(2)),
            ("nonce", serde_json::json!("")),
        ] {
            let mut document: serde_json::Value = serde_json::from_slice(&raw).unwrap();
            document["header"][field] = value;
            assert!(parse(&serde_json::to_vec(&document).unwrap()).is_err());
        }
        assert!(parse(b"{}").is_err());
        assert!(parse(&raw[..raw.len() - 1]).is_err());
        assert!(encrypt(b"x", "").is_err());
    }
}
