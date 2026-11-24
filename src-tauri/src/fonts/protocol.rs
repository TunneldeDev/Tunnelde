use super::*;
use std::io::Read;
use tauri::http::{Request, Response, StatusCode};

pub(crate) async fn capacity() -> tokio::sync::OwnedSemaphorePermit {
    static CAPACITY: std::sync::LazyLock<std::sync::Arc<tokio::sync::Semaphore>> =
        std::sync::LazyLock::new(|| std::sync::Arc::new(tokio::sync::Semaphore::new(4)));
    CAPACITY
        .clone()
        .acquire_owned()
        .await
        .expect("font capacity remains open")
}

pub(crate) fn serve(
    app: &tauri::AppHandle,
    caller: &str,
    request: Request<Vec<u8>>,
    origin: &str,
) -> Response<Vec<u8>> {
    let result = (|| -> AppResult<Vec<u8>> {
        if caller != "main" && !crate::platform::panel_windows::native::registered(app, caller) {
            return Err(invalid());
        }
        if request.method() != "GET" || request.headers().get("Origin").is_some_and(|v| v != origin)
        {
            return Err(invalid());
        }
        let id = request.uri().path().strip_prefix('/').ok_or_else(invalid)?;
        let path = repository::resource(app, id)?;
        let metadata = std::fs::symlink_metadata(&path)?;
        if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > MAX_BYTES {
            return Err(invalid());
        }
        let file = std::fs::File::open(path)?;
        let mut bytes = Vec::new();
        file.take(MAX_BYTES + 1).read_to_end(&mut bytes)?;
        repository::validate_bytes(&bytes)?;
        Ok(bytes)
    })();
    let (status, bytes) = match result {
        Ok(bytes) => (StatusCode::OK, bytes),
        Err(_) => (StatusCode::NOT_FOUND, Vec::new()),
    };
    Response::builder()
        .status(status)
        .header("Access-Control-Allow-Origin", origin)
        .header("Content-Type", "application/octet-stream")
        .header("Cache-Control", "no-store")
        .header("X-Content-Type-Options", "nosniff")
        .body(bytes)
        .unwrap()
}
