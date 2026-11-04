use quick_xml::{events::Event, Reader};
use semver::Version;

use super::channels::channel_accepts;
use super::feeds::{read_response, request, Feed};
use crate::error::{AppError, AppResult};

const RELEASES: &str = "https://github.com/TunneldeDev/Tunnelde/releases";

fn invalid() -> AppError {
    AppError::Update("updates.invalidFeed".into())
}

/// GitHub's public feed is a bounded list of recent published releases. Never use
/// titles, embedded HTML, or external links as executable update endpoints.
fn candidates(bytes: &[u8], channel: &str) -> AppResult<Vec<Feed>> {
    let mut reader = Reader::from_reader(bytes);
    reader.config_mut().expand_empty_elements = true;
    let mut path = Vec::<String>::new();
    let mut saw_root = false;
    let mut versions = Vec::new();
    loop {
        match reader.read_event().map_err(|_| invalid())? {
            Event::Start(start) => {
                if path.is_empty() {
                    if saw_root || start.name().as_ref() != "feed" {
                        return Err(invalid());
                    }
                    saw_root = true;
                }
                if path.len() > 32 {
                    return Err(invalid());
                }
                if path.len() == 2
                    && path[0] == "feed"
                    && path[1] == "entry"
                    && start.name().as_ref() == "link"
                {
                    let mut href = None;
                    let mut alternate = false;
                    for attribute in start.attributes() {
                        let attribute = attribute.map_err(|_| invalid())?;
                        let value = attribute
                            .normalized_value(quick_xml::XmlVersion::Implicit1_0)
                            .map_err(|_| invalid())?;
                        match attribute.key.as_ref() {
                            "href" => href = Some(value.into_owned()),
                            "rel" => alternate = value == "alternate",
                            _ => {}
                        }
                    }
                    if alternate {
                        if let Some(version) = href
                            .as_deref()
                            .and_then(|href| href.strip_prefix(RELEASES))
                            .and_then(|path| path.strip_prefix("/tag/v"))
                            .and_then(|tag| Version::parse(tag).ok())
                            .filter(|version| channel_accepts(version, channel))
                        {
                            versions.push(version);
                        }
                    }
                }
                path.push(start.name().as_ref().to_owned());
            }
            Event::End(_) => {
                path.pop().ok_or_else(invalid)?;
            }
            Event::DocType(_) => return Err(invalid()),
            Event::Eof => break,
            _ => {}
        }
    }
    if !saw_root || !path.is_empty() {
        return Err(invalid());
    }
    versions.sort_by(|a, b| b.cmp(a));
    versions.dedup();
    if versions.is_empty() {
        return Err(AppError::Update("updates.noFeed".into()));
    }
    Ok(versions
        .into_iter()
        .take(10)
        .map(|version| Feed {
            url: format!("{RELEASES}/download/v{version}/latest.json")
                .parse()
                .expect("validated SemVer release URL"),
            channel: channel.into(),
            page: format!("{RELEASES}/tag/v{version}"),
            version: Some(version),
            notes: None,
        })
        .collect())
}

fn validate_manifest(bytes: &[u8], expected: &Version) -> AppResult<()> {
    let manifest: tauri_plugin_updater::RemoteRelease =
        serde_json::from_slice(bytes).map_err(|_| invalid())?;
    if &manifest.version != expected {
        return Err(invalid());
    }
    Ok(())
}

pub(super) async fn fallback(client: &reqwest::Client, channel: &str) -> AppResult<Feed> {
    let response = request(client, &format!("{RELEASES}.atom")).await?;
    let bytes = read_response(response).await?;
    let feeds = candidates(&bytes, channel)?;
    first_available(client, feeds).await
}

async fn first_available(client: &reqwest::Client, feeds: Vec<Feed>) -> AppResult<Feed> {
    for feed in feeds {
        let response = request(client, feed.url.as_str()).await?;
        // GitHub's Atom cache can retain a recently deleted release. An absent
        // manifest is ineligible, but a network failure must not mean up-to-date.
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            continue;
        }
        let bytes = read_response(response).await?;
        validate_manifest(&bytes, feed.version.as_ref().unwrap())?;
        return Ok(feed);
    }
    Err(AppError::Update("updates.noFeed".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn atom(tags: &[&str]) -> String {
        let entries = tags.iter().map(|tag| format!(
            r#"<entry><link rel="alternate" href="{RELEASES}/tag/{tag}"/><content type="html">&lt;a href='bad'&gt;example&lt;/a&gt;</content></entry>"#
        )).collect::<String>();
        format!(
            r#"<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">{entries}</feed>"#
        )
    }

    #[test]
    fn selects_by_semver_and_channel_instead_of_publication_order() {
        let xml = atom(&[
            "v0.27.1-beta.9",
            "v0.27.1-beta.10",
            "v0.27.1",
            "v0.28.0-beta.1.d.2.gabcdef",
            "v0.28.0-beta.1",
            "v0.27.1",
        ]);
        for (channel, expected, count) in [
            ("stable", "0.27.1", 1),
            ("beta", "0.28.0-beta.1", 4),
            ("nightly", "0.28.0-beta.1.d.2.gabcdef", 5),
        ] {
            let feeds = candidates(xml.as_bytes(), channel).unwrap();
            assert_eq!(feeds.len(), count);
            assert_eq!(feeds[0].version, Some(Version::parse(expected).unwrap()));
        }
    }

    #[test]
    fn fixed_width_beta_migration_and_nightly_follow_semver_in_public_feed() {
        let xml = atom(&[
            "v0.28.0-beta.9",
            "v0.28.0-beta.11",
            "v0.28.0-beta09",
            "v0.28.0-beta12",
            "v0.28.0-beta10",
            "v0.28.0-beta12.d.2.gabcdef1",
        ]);
        for (channel, expected) in [
            ("beta", "0.28.0-beta12"),
            ("nightly", "0.28.0-beta12.d.2.gabcdef1"),
        ] {
            assert_eq!(
                candidates(xml.as_bytes(), channel).unwrap()[0].version,
                Some(Version::parse(expected).unwrap())
            );
        }
    }

    #[test]
    fn ignores_external_links_invalid_tags_and_links_outside_entries() {
        let xml = format!(
            r#"<feed><link rel="alternate" href="{RELEASES}/tag/v99.0.0"/>
            <entry><link rel="alternate" href="https://example.com/tag/v99.0.0"/>
            <link rel="alternate" href="{RELEASES}/tag/v0.27.1/../bad"/>
            <link rel="alternate" href="{RELEASES}/tag/v0.27.1?evil=1"/>
            <content><link rel="alternate" href="{RELEASES}/tag/v99.0.0"/></content>
            <link rel="alternate" href="{RELEASES}/tag/v0.27.1"/></entry></feed>"#
        );
        let feeds = candidates(xml.as_bytes(), "beta").unwrap();
        assert_eq!(feeds.len(), 1);
        assert!(feeds[0].url.as_str().ends_with("/v0.27.1/latest.json"));
    }

    #[test]
    fn rejects_dtd_truncated_xml_wrong_roots_and_empty_feeds() {
        for xml in [
            "<!DOCTYPE feed><feed/>",
            "<feed><entry>",
            "<html/>",
            "<feed/><feed/>",
        ] {
            assert_eq!(
                candidates(xml.as_bytes(), "beta")
                    .err()
                    .unwrap()
                    .to_string(),
                "updates.invalidFeed"
            );
        }
        assert_eq!(
            candidates(b"<feed/>", "beta").err().unwrap().to_string(),
            "updates.noFeed"
        );
    }

    #[test]
    fn manifest_must_be_valid_and_match_the_release_tag() {
        let expected = Version::parse("0.27.1-beta.10").unwrap();
        let bytes = br#"{"version":"0.27.1-beta.10","platforms":{"windows-x86_64":{"url":"https://example.com/update.exe","signature":"signed"}}}"#;
        assert!(validate_manifest(bytes, &expected).is_ok());
        assert!(validate_manifest(bytes, &Version::parse("0.27.1").unwrap()).is_err());
        assert!(validate_manifest(br#"{"version":"0.27.1-beta.10"}"#, &expected).is_err());
    }

    async fn server(responses: Vec<String>) -> (String, tokio::task::JoinHandle<()>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            for response in responses {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut buffer = [0; 4096];
                assert!(socket.read(&mut buffer).await.unwrap() > 0);
                socket.write_all(response.as_bytes()).await.unwrap();
            }
        });
        (url, task)
    }

    fn response(status: &str, body: &str) -> String {
        format!(
            "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
    }

    fn local_feeds(base: &str) -> Vec<Feed> {
        let mut feeds = candidates(
            atom(&["v0.28.0-beta.2", "v0.28.0-beta.1"]).as_bytes(),
            "beta",
        )
        .unwrap();
        for feed in &mut feeds {
            feed.url = format!("{base}/{}", feed.version.as_ref().unwrap())
                .parse()
                .unwrap();
        }
        feeds
    }

    #[tokio::test]
    async fn skips_deleted_releases_but_never_hides_network_or_manifest_failures() {
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let manifest = r#"{"version":"0.28.0-beta.1","platforms":{}}"#;
        let (base, task) = server(vec![
            response("404 Not Found", ""),
            response("200 OK", manifest),
        ])
        .await;
        let feed = first_available(&client, local_feeds(&base)).await.unwrap();
        assert_eq!(
            feed.version.unwrap(),
            Version::parse("0.28.0-beta.1").unwrap()
        );
        task.await.unwrap();

        for (status, body, expected) in [
            ("503 Service Unavailable", "", "updates.sourceUnavailable"),
            ("200 OK", manifest, "updates.invalidFeed"), // Different version than first candidate.
            ("200 OK", "broken JSON", "updates.invalidFeed"),
        ] {
            let (base, task) = server(vec![response(status, body)]).await;
            assert_eq!(
                first_available(&client, local_feeds(&base))
                    .await
                    .err()
                    .unwrap()
                    .to_string(),
                expected
            );
            task.await.unwrap();
        }
        let (base, task) = server(vec![
            response("404 Not Found", ""),
            response("404 Not Found", ""),
        ])
        .await;
        assert_eq!(
            first_available(&client, local_feeds(&base))
                .await
                .err()
                .unwrap()
                .to_string(),
            "updates.noFeed"
        );
        task.await.unwrap();
    }
}
