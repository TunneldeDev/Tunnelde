use serde::{Deserialize, Serialize};

use crate::{
    error::{AppError, AppResult},
    models::HostInput,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum IssueCode {
    ReadFailed,
    TooLarge,
    InvalidLine,
    UnsupportedOption,
    InvalidValue,
    MissingJump,
    ExistingConflict,
    IncludeCycle,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    pub code: IssueCode,
    pub detail: String,
}

impl Issue {
    pub(super) fn new(code: IssueCode, detail: impl Into<String>) -> Self {
        Self {
            code,
            detail: detail.into(),
        }
    }
}

/// IPC shape of a validated host input. Kept local so preview serialization
/// never exposes parser internals or imports unrelated model modules.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryInput {
    pub name: String,
    pub group_id: Option<String>,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_method: String,
    pub key_path: Option<String>,
    pub favorite: bool,
    pub color: Option<String>,
    pub tags: Vec<String>,
    pub note: Option<String>,
}

impl EntryInput {
    pub(super) fn into_host_input(self) -> HostInput {
        HostInput {
            name: self.name,
            group_id: self.group_id,
            host: self.host,
            port: Some(self.port),
            username: Some(self.username),
            auth_method: Some(self.auth_method),
            key_path: self.key_path,
            favorite: self.favorite,
            color: self.color,
            tags: self.tags,
            note: self.note,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub alias: String,
    pub input: Option<EntryInput>,
    pub jump_aliases: Vec<String>,
    pub issues: Vec<Issue>,
    pub existing_id: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub path: String,
    pub found: bool,
    pub revision: String,
    pub entries: Vec<Entry>,
    pub issues: Vec<Issue>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PreviewPage {
    pub found: bool,
    pub revision: String,
    pub entries: Vec<Entry>,
    pub total: usize,
    pub next_offset: Option<usize>,
    pub issues: Vec<Issue>,
}

impl PreviewPage {
    pub(crate) fn from_preview(preview: Preview, offset: usize) -> AppResult<Self> {
        let total = preview.entries.len();
        // Leave ample RPC headroom for envelope, revision and diagnostics.
        const ENTRY_BUDGET: usize = 512 * 1024;
        let mut bytes = 0;
        let mut entries = Vec::new();
        for mut entry in preview.entries.into_iter().skip(offset).take(16) {
            entry.issues.truncate(8);
            entry.issues.iter_mut().for_each(limit_detail);
            // Token expansion can produce very large identity paths. These
            // entries have already failed the shared preview's validation.
            if entry
                .input
                .as_ref()
                .and_then(|input| input.key_path.as_ref())
                .is_some_and(|path| path.chars().take(1025).count() > 1024)
            {
                entry.input = None;
            }
            // No valid route exceeds eight hops. Keep the diagnostics on
            // invalid routes, but do not return arbitrarily long hop lists.
            entry.jump_aliases.truncate(8);
            for alias in &mut entry.jump_aliases {
                truncate_utf8(alias, 320);
            }
            bytes += serde_json::to_vec(&entry)?.len() + 1;
            if bytes > ENTRY_BUDGET {
                if entries.is_empty() {
                    return Err(AppError::validation("sshImport.tooLarge"));
                }
                break;
            }
            entries.push(entry);
        }
        Ok(Self {
            found: preview.found,
            revision: preview.revision,
            next_offset: (offset + entries.len() < total).then_some(offset + entries.len()),
            entries,
            total,
            issues: preview
                .issues
                .into_iter()
                .take(16)
                .map(|mut issue| {
                    limit_detail(&mut issue);
                    issue
                })
                .collect(),
        })
    }
}

fn truncate_utf8(value: &mut String, max: usize) {
    let mut end = max.min(value.len());
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value.truncate(end);
}

fn limit_detail(issue: &mut Issue) {
    truncate_utf8(&mut issue.detail, 256);
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub imported: Vec<crate::models::Host>,
    pub skipped: usize,
}
