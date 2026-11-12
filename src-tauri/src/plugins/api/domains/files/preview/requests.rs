use crate::error::{AppError, AppResult};
use serde::Deserialize;

const MAX_SAFE: u64 = (1_u64 << 53) - 1;
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
enum Source {
    Local {},
    Remote {
        #[serde(rename = "sessionId")]
        session_id: String,
    },
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Open {
    source: Source,
    path: String,
    #[serde(default)]
    line: u64,
    #[serde(default)]
    column: u64,
}
pub(super) fn invalid() -> AppError {
    AppError::validation("plugin.filePreview.invalid")
}
impl Open {
    pub(super) fn validate(&self) -> AppResult<()> {
        if self.path.is_empty()
            || self.path.len() > 32768
            || self.path.contains('\0')
            || self.line > MAX_SAFE
            || self.column > MAX_SAFE
        {
            return Err(invalid());
        }
        let absolute = match &self.source {
            Source::Local {} => std::path::Path::new(&self.path).is_absolute(),
            Source::Remote { session_id } => {
                !session_id.is_empty()
                    && session_id.len() <= 128
                    && !session_id.chars().any(char::is_control)
                    && self.path.starts_with('/')
            }
        };
        if !absolute {
            return Err(invalid());
        }
        Ok(())
    }
    pub(super) fn permissions(&self) -> &'static [&'static str] {
        match self.source {
            Source::Local {} => &["filePreview.write", "fs.read"],
            Source::Remote { .. } => &["filePreview.write", "sftp.read"],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn open_retains_endpoint_authority_and_rejects_ambiguous_or_invalid_coordinates() {
        let good =
            json!({"source":{"kind":"remote","sessionId":"ssh-one"},"path":"/资料/a.pdf","line":2});
        let parsed: Open = serde_json::from_value(good.clone()).unwrap();
        parsed.validate().unwrap();
        assert_eq!(parsed.permissions(), &["filePreview.write", "sftp.read"]);
        for value in [
            json!({"source":{"kind":"remote","sessionId":""},"path":"/a"}),
            json!({"source":{"kind":"remote","sessionId":"ssh\n"},"path":"/a"}),
            json!({"source":{"kind":"remote","sessionId":"ssh"},"path":"relative"}),
            json!({"source":{"kind":"remote","sessionId":"ssh"},"path":"/a","column":9007199254740992_u64}),
            json!({"source":{"kind":"remote","sessionId":"ssh"},"path":"/a","line":null}),
            json!({"source":{"kind":"local","sessionId":"ssh"},"path":"/a"}),
            json!({"source":{"kind":"remote","sessionId":"ssh"},"path":"/a","unknown":true}),
        ] {
            assert!(serde_json::from_value::<Open>(value)
                .and_then(|request| request.validate().map_err(serde::de::Error::custom))
                .is_err());
        }
    }
}
