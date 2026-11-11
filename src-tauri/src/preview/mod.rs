pub mod providers;
mod range;
mod source;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{http, AppHandle, Manager, State};
use tokio::sync::{watch, Mutex as AsyncMutex, Semaphore};

use crate::error::{AppError, AppResult};
use crate::state::AppState;
use providers::Renderer;
use source::Source;

const IDLE_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const IO_TIMEOUT: Duration = Duration::from_secs(30);

struct Ticket {
    source: AsyncMutex<Option<Source>>,
    cancelled: watch::Sender<bool>,
    touched: Mutex<Instant>,
    // Bound queued requests before allocating response buffers.
    requests: Semaphore,
    size: std::sync::atomic::AtomicU64,
    mime: &'static str,
}

impl Ticket {
    fn cancel(&self) {
        self.cancelled.send_replace(true);
    }
    async fn until_cancelled(&self) {
        let mut cancelled = self.cancelled.subscribe();
        let _ = cancelled.wait_for(|value| *value).await;
    }
}

#[derive(Default)]
pub struct Registry(Mutex<HashMap<String, Arc<Ticket>>>);

impl Registry {
    fn register(&self, id: &str, mime: &'static str) -> AppResult<Arc<Ticket>> {
        if uuid::Uuid::parse_str(id).is_err() {
            return Err(AppError::validation("preview.invalidTicket"));
        }
        let mut tickets = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if tickets.len() >= 8 || tickets.contains_key(id) {
            return Err(AppError::validation("preview.busy"));
        }
        let ticket = Arc::new(Ticket {
            source: AsyncMutex::new(None),
            cancelled: watch::channel(false).0,
            touched: Mutex::new(Instant::now()),
            requests: Semaphore::new(2),
            size: std::sync::atomic::AtomicU64::new(0),
            mime,
        });
        tickets.insert(id.into(), ticket.clone());
        Ok(ticket)
    }

    fn get(&self, id: &str) -> Option<Arc<Ticket>> {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(id)
            .cloned()
    }

    fn remove(&self, id: &str) {
        if let Some(ticket) = self.0.lock().unwrap_or_else(|e| e.into_inner()).remove(id) {
            ticket.cancel();
        }
    }

    fn remove_if_same(&self, id: &str, expected: &Arc<Ticket>) {
        let mut tickets = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if tickets
            .get(id)
            .is_some_and(|ticket| Arc::ptr_eq(ticket, expected))
        {
            if let Some(ticket) = tickets.remove(id) {
                ticket.cancel();
            }
        }
    }

    pub fn clear(&self) {
        for (_, ticket) in self.0.lock().unwrap_or_else(|e| e.into_inner()).drain() {
            ticket.cancel();
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewInfo {
    id: String,
    size: u64,
    renderer: Renderer,
}

#[tauri::command]
pub fn file_preview_close(registry: State<'_, Registry>, id: String) {
    registry.remove(&id);
}

#[tauri::command]
pub async fn file_preview_open(
    app: AppHandle,
    id: String,
    provider_id: String,
    session_id: Option<String>,
    path: String,
) -> AppResult<PreviewInfo> {
    // Resolve only reviewed manifest data. Plugins receive neither the ticket nor file bytes.
    let provider = app
        .state::<AppState>()
        .plugins
        .list()
        .await
        .into_iter()
        .find_map(|plugin| {
            plugin.file_previews.into_iter().find(|provider| {
                format!("{}:{}", plugin.id, provider.id) == provider_id && provider.matches(&path)
            })
        })
        .ok_or_else(|| AppError::validation("preview.providerUnavailable"))?;
    let ticket = app
        .state::<Registry>()
        .register(&id, provider.mime(&path))?;
    let lifecycle_app = app.clone();
    let lifecycle_id = id.clone();
    let lifecycle_ticket = ticket.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::select! {
                _ = lifecycle_ticket.until_cancelled() => break,
                _ = tokio::time::sleep(Duration::from_secs(60)) => {
                    let idle = lifecycle_ticket.touched.lock().unwrap_or_else(|e| e.into_inner()).elapsed();
                    if idle >= IDLE_TIMEOUT { break; }
                }
            }
        }
        lifecycle_app
            .state::<Registry>()
            .remove_if_same(&lifecycle_id, &lifecycle_ticket);
        if let Some(source) = lifecycle_ticket.source.lock().await.take() {
            source.close().await;
        }
    });
    let result = async {
        let (source, size) = Source::open(&app, session_id.as_deref(), &path).await?;
        let limit = match provider.renderer {
            Renderer::Image => range::MAX_WHOLE,
            Renderer::Pdf => 128 * 1024 * 1024,
            Renderer::Text | Renderer::Markdown => 2 * 1024 * 1024,
            Renderer::Audio | Renderer::Video => 1024 * 1024 * 1024 * 1024,
        };
        if size > limit {
            source.close().await;
            return Err(AppError::validation("sftp.fileTooLarge"));
        }
        ticket
            .size
            .store(size, std::sync::atomic::Ordering::Release);
        let mut slot = ticket.source.lock().await;
        if *ticket.cancelled.borrow() {
            source.close().await;
            return Err(AppError::validation("preview.cancelled"));
        }
        *slot = Some(source);
        Ok(PreviewInfo {
            id: id.clone(),
            size,
            renderer: provider.renderer,
        })
    };
    let result = tokio::select! {
        biased;
        _ = ticket.until_cancelled() => Err(AppError::validation("preview.cancelled")),
        result = tokio::time::timeout(IO_TIMEOUT, result) => result.unwrap_or_else(|_| Err(AppError::validation("preview.timeout"))),
    };
    if result.is_err() {
        app.state::<Registry>().remove_if_same(&id, &ticket);
    }
    result
}

fn response(status: u16, body: Vec<u8>, origin: &str) -> http::Response<Vec<u8>> {
    http::Response::builder()
        .status(status)
        .header("Access-Control-Allow-Origin", origin)
        .header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
        .header("Access-Control-Allow-Headers", "Range")
        .header(
            "Access-Control-Expose-Headers",
            "Content-Length, Content-Range, Accept-Ranges",
        )
        .header("Cache-Control", "no-store")
        .header("X-Content-Type-Options", "nosniff")
        .header("Content-Security-Policy", "default-src 'none'; sandbox")
        .body(body)
        .expect("fixed preview response headers")
}

pub async fn serve(
    registry: &Registry,
    request: http::Request<Vec<u8>>,
    origin: String,
) -> http::Response<Vec<u8>> {
    if request.method() == http::Method::OPTIONS {
        return response(204, vec![], &origin);
    }
    if !matches!(*request.method(), http::Method::GET | http::Method::HEAD) {
        return response(405, vec![], &origin);
    }
    let id = request.uri().path().strip_prefix('/').unwrap_or("");
    let Some(ticket) = registry.get(id) else {
        return response(404, vec![], &origin);
    };
    if *ticket.cancelled.borrow() {
        return response(410, vec![], &origin);
    }
    *ticket.touched.lock().unwrap_or_else(|e| e.into_inner()) = Instant::now();
    let size = ticket.size.load(std::sync::atomic::Ordering::Acquire);
    let header = request.headers().get("Range");
    let range = if request.method() == http::Method::HEAD {
        Some(range::ByteRange {
            start: 0,
            len: size,
            partial: false,
        })
    } else {
        range::resolve(header.and_then(|value| value.to_str().ok()), size)
    };
    let Some(range) = range else {
        let mut reply = response(416, vec![], &origin);
        reply
            .headers_mut()
            .insert("Content-Range", format!("bytes */{size}").parse().unwrap());
        return reply;
    };
    let body = if request.method() == http::Method::HEAD {
        Ok(Vec::new())
    } else {
        let read = async {
            let _permit = ticket
                .requests
                .try_acquire()
                .map_err(|_| AppError::validation("preview.busy"))?;
            let mut source = ticket.source.lock().await;
            source
                .as_mut()
                .ok_or_else(|| AppError::validation("preview.cancelled"))?
                .read(range.start, range.len)
                .await
        };
        tokio::select! {
            biased;
            _ = ticket.until_cancelled() => Err(AppError::validation("preview.cancelled")),
            result = tokio::time::timeout(IO_TIMEOUT, read) => result.unwrap_or_else(|_| Err(AppError::validation("preview.timeout"))),
        }
    };
    match body {
        Ok(body) => {
            let mut reply = response(if range.partial { 206 } else { 200 }, body, &origin);
            let headers = reply.headers_mut();
            headers.insert("Content-Type", ticket.mime.parse().unwrap());
            headers.insert("Accept-Ranges", "bytes".parse().unwrap());
            headers.insert("Content-Length", range.len.to_string().parse().unwrap());
            if range.partial {
                headers.insert(
                    "Content-Range",
                    format!(
                        "bytes {}-{}/{size}",
                        range.start,
                        range.start + range.len - 1
                    )
                    .parse()
                    .unwrap(),
                );
            }
            reply
        }
        Err(_) => response(
            if *ticket.cancelled.borrow() { 410 } else { 503 },
            vec![],
            &origin,
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn whole_images_larger_than_one_range_keep_the_existing_http_contract() {
        let root =
            std::env::temp_dir().join(format!("tunnelde-whole-preview-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let path = root.join("image.png");
        let bytes = vec![b'x'; 2 * 1024 * 1024 + 17];
        std::fs::write(&path, &bytes).unwrap();
        let registry = Registry::default();
        let id = uuid::Uuid::new_v4().to_string();
        let ticket = registry.register(&id, "image/png").unwrap();
        let (reader, size) =
            crate::services::files::read::LocalReader::open(path.to_string_lossy().into_owned())
                .await
                .unwrap();
        *ticket.source.lock().await = Some(Source::Local(reader));
        ticket
            .size
            .store(size, std::sync::atomic::Ordering::Release);
        let request = http::Request::builder()
            .uri(format!("preview://localhost/{id}"))
            .body(vec![])
            .unwrap();
        let reply = serve(&registry, request, "tauri://localhost".into()).await;
        assert_eq!(reply.status(), 200);
        assert_eq!(reply.body(), &bytes);
        let request = http::Request::builder()
            .uri(format!("preview://localhost/{id}"))
            .header("Range", "bytes=0-")
            .body(vec![])
            .unwrap();
        let reply = serve(&registry, request, "tauri://localhost".into()).await;
        assert_eq!(reply.status(), 206);
        assert_eq!(reply.body().len() as u64, range::MAX_RANGE);
        assert!(ticket
            .source
            .lock()
            .await
            .as_mut()
            .unwrap()
            .read(0, range::MAX_WHOLE + 1)
            .await
            .is_err());
        registry.remove(&id);
        drop(ticket);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn tickets_are_bounded_revocable_and_not_paths() {
        let registry = Registry::default();
        assert!(registry.register("/etc/passwd", "text/plain").is_err());
        let id = uuid::Uuid::new_v4().to_string();
        let ticket = registry.register(&id, "image/png").unwrap();
        assert!(registry.register(&id, "image/png").is_err());
        registry.remove(&id);
        ticket.until_cancelled().await;
        assert!(registry.get(&id).is_none());
        for _ in 0..8 {
            registry
                .register(&uuid::Uuid::new_v4().to_string(), "image/png")
                .unwrap();
        }
        assert!(registry
            .register(&uuid::Uuid::new_v4().to_string(), "image/png")
            .is_err());
    }

    #[tokio::test]
    async fn serves_real_local_bytes_and_head_with_bounded_ranges_and_revocation() {
        let root = std::env::temp_dir().join(format!("tunnelde-preview-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let path = root.join("bytes.mp4");
        let bytes: Vec<u8> = (0..200).collect();
        std::fs::write(&path, &bytes).unwrap();
        let registry = Registry::default();
        let id = uuid::Uuid::new_v4().to_string();
        let ticket = registry.register(&id, "video/mp4").unwrap();
        *ticket.source.lock().await = Some(Source::Local(
            crate::services::files::read::LocalReader::open(path.to_string_lossy().into_owned())
                .await
                .unwrap()
                .0,
        ));
        ticket.size.store(200, std::sync::atomic::Ordering::Release);
        let request = |method: &str, range: Option<&str>| {
            let request = http::Request::builder()
                .method(method)
                .uri(format!("preview://localhost/{id}"));
            let request = match range {
                Some(value) => request.header("Range", value),
                None => request,
            };
            request.body(vec![]).unwrap()
        };
        let reply = serve(
            &registry,
            request("GET", Some("bytes=10-19")),
            "tauri://localhost".into(),
        )
        .await;
        assert_eq!(reply.status(), 206);
        assert_eq!(reply.headers()["Content-Range"], "bytes 10-19/200");
        assert_eq!(reply.headers()["Content-Type"], "video/mp4");
        assert_eq!(reply.body(), &bytes[10..20]);
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        let reply = serve(&registry, request("HEAD", None), "tauri://localhost".into()).await;
        assert_eq!(reply.headers()["Content-Length"], "200");
        assert!(reply.body().is_empty());
        let reply = serve(
            &registry,
            request("GET", Some("bytes=201-")),
            "tauri://localhost".into(),
        )
        .await;
        assert_eq!(reply.status(), 416);
        assert_eq!(reply.headers()["Content-Range"], "bytes */200");
        let reply = serve(&registry, request("POST", None), "tauri://localhost".into()).await;
        assert_eq!(reply.status(), 405);
        registry.remove(&id);
        let reply = serve(&registry, request("GET", None), "tauri://localhost".into()).await;
        assert_eq!(reply.status(), 404);
        let source = ticket.source.lock().await.take().unwrap();
        source.close().await;
        drop(ticket);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn close_interrupts_queued_reads_and_old_cleanup_cannot_revoke_a_new_ticket() {
        let registry = Registry::default();
        let id = uuid::Uuid::new_v4().to_string();
        let ticket = registry.register(&id, "image/png").unwrap();
        ticket.size.store(10, std::sync::atomic::Ordering::Release);
        let _busy_source = ticket.source.lock().await;
        let request = http::Request::builder()
            .uri(format!("preview://localhost/{id}"))
            .body(vec![])
            .unwrap();
        let read = serve(&registry, request, "tauri://localhost".into());
        let cancel = async {
            tokio::task::yield_now().await;
            registry.remove(&id);
        };
        let (reply, _) = tokio::join!(read, cancel);
        assert_eq!(reply.status(), 410);
        let next = registry.register(&id, "image/png").unwrap();
        registry.remove_if_same(&id, &ticket);
        assert!(!*next.cancelled.borrow());
        registry.clear();
        assert!(*next.cancelled.borrow());
    }
}
