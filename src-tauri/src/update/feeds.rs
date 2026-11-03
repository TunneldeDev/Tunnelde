use std::time::Duration;

use semver::Version;
use serde::Deserialize;
use tauri::AppHandle;

use super::channels::{channel_accepts, source_channels};
use super::{validate_preferences, RELEASES_PAGE};
use crate::error::{AppError, AppResult};
use crate::settings::Settings;

const RELEASES_API: &str =
    "https://api.github.com/repos/TunneldeDev/Tunnelde/releases?per_page=100";

#[derive(Debug, Deserialize)]
pub(super) struct ReleaseAsset {
    pub(super) name: String,
}

#[derive(Debug, Deserialize)]
pub(super) struct GitHubRelease {
    pub(super) tag_name: String,
    pub(super) draft: bool,
    pub(super) prerelease: bool,
    pub(super) assets: Vec<ReleaseAsset>,
    #[serde(default)]
    pub(super) body: Option<String>,
}

pub(super) struct Feed {
    pub(super) url: reqwest::Url,
    pub(super) channel: String,
    pub(super) version: Option<Version>,
    pub(super) page: String,
    pub(super) notes: Option<String>,
}

pub(super) fn github_channel_feed(releases: &[GitHubRelease], channel: &str) -> AppResult<Feed> {
    let (version, release) = releases
        .iter()
        .filter(|release| !release.draft && release.assets.iter().any(|a| a.name == "latest.json"))
        .filter_map(|release| {
            let version = Version::parse(release.tag_name.strip_prefix('v')?).ok()?;
            let eligible =
                release.prerelease != version.pre.is_empty() && channel_accepts(&version, channel);
            eligible.then_some((version, release))
        })
        .max_by(|a, b| a.0.cmp(&b.0))
        .ok_or_else(|| AppError::Update("updates.noFeed".into()))?;
    let tag = &release.tag_name;
    Ok(Feed {
        url: format!("https://github.com/TunneldeDev/Tunnelde/releases/download/{tag}/latest.json")
            .parse()
            .map_err(|_| AppError::Update("updates.noFeed".into()))?,
        channel: channel.into(),
        version: Some(version),
        page: format!("https://github.com/TunneldeDev/Tunnelde/releases/tag/{tag}"),
        notes: release.body.clone(),
    })
}

pub(super) async fn feeds(app: &AppHandle, settings: &Settings) -> AppResult<Vec<Feed>> {
    validate_preferences(settings)?;
    if settings.update_source == "custom" {
        if settings.update_source_url.is_empty() {
            return Err(AppError::validation("updates.invalidSource"));
        }
        return source_channels(&settings.update_channel)
            .iter()
            .map(|channel| {
                Ok(Feed {
                    url: settings
                        .update_source_url
                        .replace("{channel}", channel)
                        .parse()
                        .map_err(|_| AppError::validation("updates.invalidSource"))?,
                    // The chosen channel accepts releases from every queried endpoint.
                    channel: settings.update_channel.clone(),
                    version: None,
                    notes: None,
                    page: if *channel == "stable" {
                        RELEASES_PAGE.into()
                    } else {
                        "https://github.com/TunneldeDev/Tunnelde/releases".into()
                    },
                })
            })
            .collect();
    }
    if settings.update_channel == "stable" {
        return Ok(vec![Feed {
            url: format!("{RELEASES_PAGE}/download/latest.json")
                .parse()
                .unwrap(),
            channel: "stable".into(),
            version: None,
            notes: None,
            page: RELEASES_PAGE.into(),
        }]);
    }
    let client = crate::network::http_client(app, "updates")?;
    let mut releases = Vec::new();
    // Retained release history can exceed one page. Never choose an obsolete package
    // simply because a newer Beta or stable release fell outside the first page.
    for page in 1..=10 {
        let mut response = client
            .get(format!("{RELEASES_API}&page={page}"))
            .timeout(Duration::from_secs(30))
            .send()
            .await
            .and_then(reqwest::Response::error_for_status)
            .map_err(|_| AppError::Update("updates.sourceUnavailable".into()))?;
        let has_next = response
            .headers()
            .get(reqwest::header::LINK)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.contains("rel=\"next\""));
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| AppError::Update("updates.sourceUnavailable".into()))?
        {
            if bytes.len() + chunk.len() > 4 * 1024 * 1024 {
                return Err(AppError::Update("updates.invalidFeed".into()));
            }
            bytes.extend_from_slice(&chunk);
        }
        let batch = serde_json::from_slice::<Vec<GitHubRelease>>(&bytes)
            .map_err(|_| AppError::Update("updates.invalidFeed".into()))?;
        releases.extend(batch);
        if !has_next {
            return Ok(vec![github_channel_feed(
                &releases,
                &settings.update_channel,
            )?]);
        }
    }
    Err(AppError::Update("updates.invalidFeed".into()))
}
