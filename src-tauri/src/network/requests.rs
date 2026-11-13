//! Read-only HTTPS resilience shared by marketplace and optional component setup.
use std::time::Duration;

/// Retry only an idempotent GET whose TLS handshake ended prematurely.
/// The caller's client owns route, TLS validation and redirects throughout.
/// Authentication/certificate failures, HTTP responses and body failures are
/// returned without replay. This must never wrap a remote mutation.
pub(crate) async fn idempotent_get(
    client: &reqwest::Client,
    url: reqwest::Url,
    timeout: Duration,
) -> Result<reqwest::Response, reqwest::Error> {
    for attempt in 0..3 {
        let result = client.get(url.clone()).timeout(timeout).send().await;
        if let Err(error) = &result {
            let detail = format!("{error:?}").to_ascii_lowercase();
            if attempt < 2
                && error.is_connect()
                && (detail.contains("tls handshake eof")
                    || detail.contains("unexpected eof during handshake"))
            {
                tokio::time::sleep(Duration::from_millis(250 * (attempt + 1))).await;
                continue;
            }
        }
        return result;
    }
    unreachable!("bounded request retries always return")
}
