use std::{future::Future, time::Duration};

use serde::Serialize;
use tauri::AppHandle;

use crate::error::{AppError, AppResult};

const BUDGET: Duration = Duration::from_secs(15);
const SAMPLES: usize = 3;

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Quality {
    Fast,
    Normal,
    Slow,
    Unstable,
    Unreachable,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionQuality {
    attempts: usize,
    successful: usize,
    samples_ms: Vec<Option<u64>>,
    median_ms: Option<u64>,
    min_ms: Option<u64>,
    max_ms: Option<u64>,
    spread_ms: Option<u64>,
    quality: Quality,
    last_error: Option<AppError>,
    #[serde(skip_serializing_if = "Option::is_none")]
    https: Option<HttpsQuality>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HttpsQuality {
    elapsed_ms: u64,
    success: bool,
    status: Option<u16>,
    error: Option<AppError>,
}

async fn check_https(host: &str, url: &str) -> HttpsQuality {
    let started = std::time::Instant::now();
    let result = async {
        let client = super::http_client_for_proxy(Some(url))?;
        let target = reqwest::Url::parse(&format!("https://{}/", super::authority(host)))
            .map_err(|_| AppError::validation("network.invalid"))?;
        // Complete TLS and HTTP through the same explicit route as the TCP test.
        let response = client
            .head(target)
            .timeout(Duration::from_secs(15))
            .send()
            .await
            .map_err(|error| {
                if error.is_timeout() {
                    AppError::validation("network.timeout")
                } else {
                    AppError::validation("network.httpsFailed")
                }
            })?;
        Ok::<_, AppError>(response.status().as_u16())
    }
    .await;
    HttpsQuality {
        elapsed_ms: started.elapsed().as_millis().min(u64::MAX as u128) as u64,
        success: result.is_ok(),
        status: result.as_ref().ok().copied(),
        error: result.err(),
    }
}

fn summarize(samples_ms: Vec<Option<u64>>, last_error: Option<AppError>) -> ConnectionQuality {
    let mut values: Vec<u64> = samples_ms.iter().flatten().copied().collect();
    values.sort_unstable();
    let median_ms = match values.len() {
        0 => None,
        2 => Some(values[0] + (values[1] - values[0]) / 2),
        n => Some(values[n / 2]),
    };
    let quality = match median_ms {
        None => Quality::Unreachable,
        Some(_) if values.len() < samples_ms.len() => Quality::Unstable,
        Some(ms) if ms <= 100 => Quality::Fast,
        Some(ms) if ms <= 300 => Quality::Normal,
        _ => Quality::Slow,
    };
    ConnectionQuality {
        attempts: samples_ms.len(),
        successful: values.len(),
        median_ms,
        min_ms: values.first().copied(),
        max_ms: values.last().copied(),
        spread_ms: (values.len() > 1).then(|| values[values.len() - 1] - values[0]),
        samples_ms,
        quality,
        last_error,
        https: None,
    }
}

async fn measure<F, Fut>(mut connect: F, budget: Duration) -> AppResult<ConnectionQuality>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = AppResult<u64>>,
{
    let deadline = tokio::time::Instant::now() + budget;
    let mut samples = Vec::with_capacity(SAMPLES);
    let mut last_error = None;
    for _ in 0..SAMPLES {
        match tokio::time::timeout_at(deadline, connect()).await {
            Ok(Ok(ms)) => samples.push(Some(ms)),
            Ok(Err(error)) => {
                // Never retry rejected proxy authentication or invalid configuration.
                if !matches!(&error, AppError::Io(_))
                    && !matches!(&error, AppError::Validation(key) if ["network.timeout", "network.failed"].contains(&key.as_str()))
                {
                    return Err(error);
                }
                samples.push(None);
                last_error = Some(error);
            }
            Err(_) => {
                samples.push(None);
                last_error = Some(AppError::validation("network.timeout"));
                break;
            }
        }
    }
    Ok(summarize(samples, last_error))
}

async fn measure_route(host: &str, port: u16, url: &str) -> AppResult<ConnectionQuality> {
    measure(
        || async {
            let started = std::time::Instant::now();
            let stream = super::dial(host, port, url).await?;
            let ms = started.elapsed().as_millis().min(u64::MAX as u128) as u64;
            // No application payload or target login; close every temporary transport.
            drop(stream);
            Ok(ms)
        },
        BUDGET,
    )
    .await
}

#[tauri::command]
pub async fn proxy_test_quality(
    app: AppHandle,
    proxy: String,
    host: String,
    port: u16,
) -> AppResult<ConnectionQuality> {
    // Freeze the selected route across all samples, including system proxy resolution.
    let url = super::tcp_proxy(&app, &host, port, &proxy)?;
    let mut quality = measure_route(&host, port, &url).await?;
    if port == 443 && quality.successful > 0 {
        quality.https = Some(check_https(&host, &url).await);
    }
    Ok(quality)
}

#[cfg(test)]
mod tests;
