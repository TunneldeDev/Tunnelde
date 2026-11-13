//! One bounded JSON request per authenticated loopback connection.
mod location;
use super::{contract::*, domains};
pub(super) use location::{default_pointer, read as read_endpoint};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};

#[derive(Default)]
pub(crate) struct Lifecycle(std::sync::Mutex<(bool, Option<location::Registration>)>);

pub(crate) fn stop(app: &AppHandle) {
    let state = app.state::<Lifecycle>();
    let mut guard = state.0.lock().unwrap_or_else(|error| error.into_inner());
    guard.0 = true;
    guard.1.take();
}

pub(crate) fn start(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = serve(app).await {
            // No token, request params or untrusted path is recorded.
            tracing::warn!(target: "automation", error_kind = ?error.kind(),
                "Local automation unavailable; desktop remains available");
        }
    });
}

async fn serve(app: AppHandle) -> std::io::Result<()> {
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await?;
    let token = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let registration = location::Registration::create(
        &app.state::<crate::state::AppState>().data_dir,
        &Endpoint {
            version: VERSION,
            address: listener.local_addr()?,
            token: token.clone(),
        },
    )?;
    {
        let state = app.state::<Lifecycle>();
        let mut guard = state.0.lock().unwrap_or_else(|error| error.into_inner());
        if guard.0 {
            return Ok(());
        }
        guard.1 = Some(registration);
    }
    let capacity = Arc::new(tokio::sync::Semaphore::new(8));
    tracing::debug!(target: "automation", "Authenticated local automation ready");
    loop {
        let (stream, peer) = listener.accept().await?;
        if !peer.ip().is_loopback() {
            continue;
        }
        let Ok(permit) = capacity.clone().try_acquire_owned() else {
            continue;
        };
        let app = app.clone();
        let token = token.clone();
        tauri::async_runtime::spawn(async move {
            let _permit = permit;
            let _ = connection(stream, &token, |request| {
                let app = app.clone();
                async move { domains::call(&app, &request.method, request.params).await }
            })
            .await;
        });
    }
}

async fn connection<F, W>(stream: TcpStream, token: &str, call: F) -> std::io::Result<()>
where
    F: FnOnce(Request) -> W,
    W: std::future::Future<Output = Result<serde_json::Value, Failure>>,
{
    connection_with_budgets(
        stream,
        token,
        call,
        Duration::from_secs(10),
        execution_budget,
    )
    .await
}

async fn connection_with_budgets<F, W>(
    stream: TcpStream,
    token: &str,
    call: F,
    framing: Duration,
    budget: impl Fn(&str) -> Duration,
) -> std::io::Result<()>
where
    F: FnOnce(Request) -> W,
    W: std::future::Future<Output = Result<serde_json::Value, Failure>>,
{
    let started = tokio::time::Instant::now();
    let mut deadline = started + framing;
    let mut stream = BufReader::new(stream);
    let mut bytes = Vec::new();
    tokio::time::timeout_at(
        deadline,
        (&mut stream)
            .take((MAX_REQUEST + 1) as u64)
            .read_until(b'\n', &mut bytes),
    )
    .await
    .map_err(|_| std::io::Error::from(std::io::ErrorKind::TimedOut))??;
    let response = if bytes.len() > MAX_REQUEST || bytes.last() != Some(&b'\n') {
        Response::new(
            String::new(),
            Err(Failure::new(
                "invalid_request",
                "Request exceeds limit or is missing a newline",
            )),
        )
    } else {
        match serde_json::from_slice::<Request>(&bytes) {
            Err(_) => Response::new(
                String::new(),
                Err(Failure::new(
                    "invalid_request",
                    "Malformed local API request",
                )),
            ),
            Ok(request) => {
                let id = if request.id.len() <= 128 && !request.id.chars().any(char::is_control) {
                    request.id.clone()
                } else {
                    String::new()
                };
                match validate(&request, token) {
                    Ok(()) => {
                        let execution = budget(&request.method);
                        // Preserve the original whole-exchange deadline for
                        // noninteractive calls. Extra time is granted only
                        // after authentication and strict request validation.
                        if execution > framing {
                            deadline = tokio::time::Instant::now() + execution;
                        }
                        let result = tokio::time::timeout_at(deadline, call(request))
                            .await
                            .map_err(|_| std::io::Error::from(std::io::ErrorKind::TimedOut))?;
                        Response::new(id, result)
                    }
                    Err(error) => Response::new(id, Err(error)),
                }
            }
        }
    };
    let mut encoded = serde_json::to_vec(&response)?;
    if encoded.len() >= MAX_RESPONSE {
        encoded = serde_json::to_vec(&Response::new(
            response.id,
            Err(Failure::new(
                "response_too_large",
                "Result exceeds the local API response limit",
            )),
        ))?;
    }
    encoded.push(b'\n');
    tokio::time::timeout_at(deadline, async {
        stream.get_mut().write_all(&encoded).await?;
        stream.get_mut().shutdown().await
    })
    .await
    .map_err(|_| std::io::Error::from(std::io::ErrorKind::TimedOut))?
}

#[cfg(test)]
mod tests;

#[cfg(test)]
pub(super) async fn contract_samples() -> Vec<serde_json::Value> {
    tests::contract_samples().await
}
