use std::collections::BTreeMap;
use std::time::Duration;

use semver::Version;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use super::channels::channel_accepts;
use super::feeds::{read_response, request};
use super::UpdateState;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

const RELEASES_API: &str =
    "https://api.github.com/repos/TunneldeDev/Tunnelde/releases?per_page=100";
const MAX_PAGES: usize = 10;
const MAX_BYTES: usize = 8 * 1024 * 1024;
const MAX_NOTES: usize = 1024 * 1024;
const MAX_ENTRIES: usize = 200;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseNotes {
    pub version: String,
    pub notes: Option<String>,
    pub published_at: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseHistory {
    pub current_version: String,
    pub version: String,
    pub entries: Vec<ReleaseNotes>,
    pub complete: bool,
    // A localized explanation is shown inline, never as an update-check failure.
    pub reason: Option<String>,
}

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    draft: bool,
    prerelease: bool,
    body: Option<String>,
    published_at: Option<String>,
}

struct HistoryBuilder {
    current: Version,
    target: Version,
    channel: String,
    entries: BTreeMap<Version, ReleaseNotes>,
    notes_bytes: usize,
    found_target: bool,
    limited: bool,
}

impl HistoryBuilder {
    fn new(snapshot: &UpdateState) -> AppResult<Self> {
        let parse = |value: &str| {
            Version::parse(value).map_err(|_| AppError::Update("updates.checkAgain".into()))
        };
        let current = parse(&snapshot.current_version)?;
        let target = parse(snapshot.version.as_deref().unwrap_or_default())?;
        if target <= current || !channel_accepts(&target, &snapshot.channel) {
            return Err(AppError::Update("updates.checkAgain".into()));
        }
        let mut this = Self {
            current,
            target: target.clone(),
            channel: snapshot.channel.clone(),
            entries: BTreeMap::new(),
            notes_bytes: 0,
            found_target: false,
            limited: false,
        };
        // Keep the selected manifest's notes even if history is offline or incomplete.
        let notes = this.bounded_notes(snapshot.notes.clone());
        this.entries.insert(
            target,
            ReleaseNotes {
                version: snapshot.version.clone().unwrap(),
                notes,
                published_at: snapshot.published_at,
            },
        );
        Ok(this)
    }

    fn bounded_notes(&mut self, notes: Option<String>) -> Option<String> {
        notes.map(|mut notes| {
            let available = MAX_NOTES.saturating_sub(self.notes_bytes);
            if notes.len() > available {
                let mut end = available;
                while !notes.is_char_boundary(end) {
                    end -= 1;
                }
                notes.truncate(end);
                self.limited = true;
            }
            self.notes_bytes += notes.len();
            notes
        })
    }

    fn add(&mut self, releases: Vec<Release>) {
        for release in releases {
            let Some(version) = release
                .tag_name
                .strip_prefix('v')
                .and_then(|tag| Version::parse(tag).ok())
            else {
                continue;
            };
            if release.draft
                || release.prerelease == version.pre.is_empty()
                || version <= self.current
                || version > self.target
                || !channel_accepts(&version, &self.channel)
            {
                continue;
            }
            if version == self.target {
                self.found_target = true;
            }
            // Release tags are unique; duplicate records must not consume the budget.
            if self.entries.contains_key(&version) && version != self.target {
                continue;
            }
            if self.entries.len() >= MAX_ENTRIES && !self.entries.contains_key(&version) {
                self.limited = true;
                continue;
            }
            let existing = self.entries.get(&version);
            let notes = existing
                .and_then(|entry| entry.notes.clone())
                .filter(|notes| !notes.trim().is_empty())
                .or(release.body);
            self.notes_bytes = self.notes_bytes.saturating_sub(
                existing
                    .and_then(|entry| entry.notes.as_ref())
                    .map_or(0, String::len),
            );
            let notes = self.bounded_notes(notes);
            let published_at = release
                .published_at
                .as_deref()
                .and_then(|date| chrono::DateTime::parse_from_rfc3339(date).ok())
                .map(|date| date.timestamp_millis())
                .or_else(|| {
                    self.entries
                        .get(&version)
                        .and_then(|entry| entry.published_at)
                });
            self.entries.insert(
                version.clone(),
                ReleaseNotes {
                    version: version.to_string(),
                    notes,
                    published_at,
                },
            );
        }
    }

    fn finish(self, exhausted: bool, reason: Option<&str>) -> ReleaseHistory {
        let complete = exhausted && self.found_target && !self.limited;
        let reason = if self.limited {
            Some("updates.historyLimit")
        } else if exhausted && !self.found_target {
            Some("updates.historyMissingTarget")
        } else {
            reason
        };
        ReleaseHistory {
            current_version: self.current.to_string(),
            version: self.target.to_string(),
            entries: self.entries.into_values().rev().collect(),
            complete,
            reason: reason.map(str::to_owned),
        }
    }
}

async fn fetch(
    client: &reqwest::Client,
    endpoint: &str,
    mut history: HistoryBuilder,
    budget: Duration,
) -> ReleaseHistory {
    let deadline = tokio::time::Instant::now() + budget;
    let mut bytes_read = 0;
    for page in 1..=MAX_PAGES {
        let result = tokio::time::timeout_at(deadline, async {
            // Build pagination locally; never follow an untrusted Link URL.
            let response = request(client, &format!("{endpoint}&page={page}")).await?;
            let has_next = response
                .headers()
                .get(reqwest::header::LINK)
                .and_then(|value| value.to_str().ok())
                .is_some_and(|value| value.contains("rel=\"next\""));
            let bytes = read_response(response).await?;
            let releases = serde_json::from_slice::<Vec<Release>>(&bytes)
                .map_err(|_| AppError::Update("updates.invalidFeed".into()))?;
            Ok::<_, AppError>((releases, has_next, bytes.len()))
        })
        .await;
        match result {
            Ok(Ok((releases, has_next, size))) => {
                bytes_read += size;
                if bytes_read > MAX_BYTES {
                    return history.finish(false, Some("updates.historyLimit"));
                }
                history.add(releases);
                if !has_next {
                    return history.finish(true, None);
                }
            }
            // Keep any earlier pages. Notes are optional metadata and never change
            // the exact pending updater/package or the installation state.
            _ => return history.finish(false, Some("updates.historyUnavailable")),
        }
    }
    history.finish(false, Some("updates.historyLimit"))
}

/// Only reads history for the exact checked update. This command cannot select
/// packages, install updates, or accept arbitrary endpoints from the WebView.
pub async fn load(app: AppHandle, version: String) -> AppResult<ReleaseHistory> {
    let service = app.state::<AppState>();
    let snapshot = service.update.snapshot();
    let settings = service.settings();
    if !snapshot.available
        || snapshot.version.as_deref() != Some(version.as_str())
        || !snapshot.matches(&settings)
    {
        return Err(AppError::Update("updates.checkAgain".into()));
    }
    let history = HistoryBuilder::new(&snapshot)?;
    if settings.update_source == "custom" {
        return Ok(history.finish(false, Some("updates.historyCustom")));
    }
    let result = match crate::network::http_client(&app, "updates") {
        Ok(client) => fetch(&client, RELEASES_API, history, Duration::from_secs(25)).await,
        Err(_) => history.finish(false, Some("updates.historyUnavailable")),
    };
    let latest = service.update.snapshot();
    if !latest.matches(&settings)
        || !latest.matches(&service.settings())
        || latest.version != snapshot.version
        || latest.last_checked != snapshot.last_checked
    {
        return Err(AppError::Update("updates.checkAgain".into()));
    }
    Ok(result)
}

#[cfg(test)]
mod tests;
