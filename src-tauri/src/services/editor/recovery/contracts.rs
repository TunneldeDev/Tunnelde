use serde::{Deserialize, Serialize};

pub(super) const MAX_DOCUMENT_BYTES: usize = 128 * 1024;
pub(super) const MAX_DRAFTS: usize = 40;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum Source {
    Local,
    Remote {
        #[serde(rename = "hostId")]
        host_id: String,
        address: String,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Draft {
    pub id: String,
    pub path: String,
    pub source: Source,
    pub baseline: String,
    pub content: String,
}

#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Snapshot {
    pub revision: String,
    pub drafts: Vec<Draft>,
}

pub(super) fn validate(drafts: &[Draft]) -> crate::error::AppResult<()> {
    let mut ids = std::collections::HashSet::new();
    let valid = drafts.len() <= MAX_DRAFTS
        && drafts.iter().all(|draft| {
            uuid::Uuid::parse_str(&draft.id).is_ok()
                && ids.insert(&draft.id)
                && !draft.path.is_empty()
                && draft.path.len() <= 32768
                && !draft.path.contains('\0')
                && draft.baseline.len() <= MAX_DOCUMENT_BYTES
                && draft.content.len() <= MAX_DOCUMENT_BYTES
                && draft.baseline != draft.content
                && match &draft.source {
                    Source::Local => std::path::Path::new(&draft.path).is_absolute(),
                    Source::Remote { host_id, address } => {
                        draft.path.starts_with('/')
                            && !host_id.is_empty()
                            && host_id.len() <= 512
                            && !address.is_empty()
                            && address.len() <= 4096
                            && !host_id.contains('\0')
                            && !address.contains('\0')
                    }
                }
        });
    if !valid {
        return Err(crate::error::AppError::validation("editor.recoveryInvalid"));
    }
    Ok(())
}
