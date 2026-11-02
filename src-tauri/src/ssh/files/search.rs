use std::collections::HashMap;
use std::io::Read;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::AppHandle;
use tokio::io::AsyncReadExt;

use crate::error::{AppError, AppResult};

const MAX_FILE: u64 = 512 * 1024;
const MAX_BYTES: usize = 8 * 1024 * 1024;
const MAX_ENTRIES: usize = 4000;
const MAX_RESULTS: usize = 100;
const MAX_DEPTH: usize = 8;
const DURATION: Duration = Duration::from_secs(15);
type SearchRequests = HashMap<String, (Arc<AtomicBool>, Instant)>;
static REQUESTS: LazyLock<Mutex<SearchRequests>> = LazyLock::new(Mutex::default);

#[derive(Default, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub matches: Vec<SearchMatch>,
    pub limited: bool,
    pub skipped: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatch {
    pub path: String,
    pub line: usize,
    pub column: usize,
    pub preview: String,
}

struct Search {
    needle: String,
    content: bool,
    cancel: Arc<AtomicBool>,
    started: Instant,
    entries: usize,
    bytes: usize,
    result: SearchResult,
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 100 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

pub fn cancel(id: &str) {
    if !valid_id(id) {
        return;
    }
    if let Ok(mut requests) = REQUESTS.lock() {
        requests.retain(|_, (_, time)| time.elapsed() < Duration::from_secs(30));
        if let Some((flag, _)) = requests.get(id) {
            flag.store(true, Ordering::Relaxed);
        } else if requests.len() < 64 {
            // Cancellation can arrive before the search command is scheduled.
            requests.insert(id.into(), (Arc::new(AtomicBool::new(true)), Instant::now()));
        }
    }
}

impl Search {
    fn stopped(&mut self) -> bool {
        let stop = self.cancel.load(Ordering::Relaxed)
            || self.started.elapsed() >= DURATION
            || self.entries >= MAX_ENTRIES
            || self.bytes >= MAX_BYTES
            || self.result.matches.len() >= MAX_RESULTS;
        self.result.limited |= stop;
        stop
    }
    fn name(&mut self, path: &str, name: &str) {
        if !self.content && name.to_lowercase().contains(&self.needle) {
            self.result.matches.push(SearchMatch {
                path: path.into(),
                line: 0,
                column: 0,
                preview: name.into(),
            });
        }
    }
    fn text(&mut self, path: &str, bytes: &[u8]) {
        self.bytes += bytes.len();
        let Ok(content) = std::str::from_utf8(bytes) else {
            self.result.skipped += 1;
            return;
        };
        if bytes.len() > MAX_FILE as usize || bytes.contains(&0) {
            self.result.skipped += 1;
            return;
        }
        for (line, text) in content.lines().enumerate() {
            if self.stopped() {
                break;
            }
            let lower = text.to_lowercase();
            if let Some(offset) = lower.find(&self.needle) {
                // Compute source character positions, including Unicode case expansions.
                let mut expanded = 0;
                let column = text
                    .chars()
                    .take_while(|ch| {
                        let before = expanded;
                        expanded += ch.to_lowercase().map(char::len_utf8).sum::<usize>();
                        before < offset
                    })
                    .count();
                self.result.matches.push(SearchMatch {
                    path: path.into(),
                    line: line + 1,
                    column: column + 1,
                    preview: text
                        .chars()
                        .skip(column.saturating_sub(60))
                        .take(240)
                        .collect(),
                });
            }
        }
    }
}

fn ignored(name: &str) -> bool {
    name.starts_with('.')
        || matches!(
            name,
            "node_modules" | "target" | "dist" | "build" | "vendor" | "__pycache__"
        )
}

fn local(mut search: Search, root: String) -> AppResult<SearchResult> {
    let root = PathBuf::from(root).canonicalize()?;
    if !root.is_dir() {
        return Err(AppError::validation("search.invalidRoot"));
    }
    let mut stack = vec![(root, 0)];
    while let Some((directory, depth)) = stack.pop() {
        if search.stopped() {
            break;
        }
        let entries = match std::fs::read_dir(directory) {
            Ok(entries) => entries,
            Err(_) => {
                search.result.skipped += 1;
                continue;
            }
        };
        for entry in entries {
            if search.stopped() {
                break;
            }
            search.entries += 1;
            let Ok(entry) = entry else {
                search.result.skipped += 1;
                continue;
            };
            let name = entry.file_name().to_string_lossy().into_owned();
            if ignored(&name) {
                continue;
            }
            let Ok(meta) = std::fs::symlink_metadata(entry.path()) else {
                search.result.skipped += 1;
                continue;
            };
            if meta.is_symlink() || local_reparse(&meta) {
                continue;
            }
            if meta.is_dir() {
                if depth < MAX_DEPTH {
                    stack.push((entry.path(), depth + 1));
                } else {
                    search.result.limited = true;
                }
                continue;
            }
            if !meta.is_file() {
                continue;
            }
            let path = super::display_path(&entry.path());
            search.name(&path, &name);
            if search.content {
                if meta.len() > MAX_FILE {
                    search.result.skipped += 1;
                    continue;
                }
                let Ok(file) = std::fs::File::open(entry.path()) else {
                    search.result.skipped += 1;
                    continue;
                };
                let mut bytes = Vec::new();
                if file.take(MAX_FILE + 1).read_to_end(&mut bytes).is_ok() {
                    search.text(&path, &bytes);
                } else {
                    search.result.skipped += 1;
                }
            }
        }
    }
    Ok(search.result)
}

fn local_reparse(meta: &std::fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        meta.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        let _ = meta;
        false
    }
}

async fn remote(
    app: &AppHandle,
    session: &str,
    root: String,
    mut search: Search,
) -> AppResult<SearchResult> {
    let cancel = search.cancel.clone();
    let result = {
        let sftp = tokio::time::timeout(Duration::from_secs(5), super::session(app, session))
            .await
            .map_err(|_| AppError::validation("search.timeout"))??;
        let run = async {
            let root = sftp.canonicalize(root).await.map_err(super::map_sftp)?;
            if !sftp
                .metadata(&root)
                .await
                .map_err(super::map_sftp)?
                .is_dir()
            {
                return Err(AppError::validation("search.invalidRoot"));
            }
            let mut stack = vec![(root, 0)];
            while let Some((directory, depth)) = stack.pop() {
                if search.stopped() {
                    break;
                }
                let entries = match sftp.read_dir(directory).await {
                    Ok(entries) => entries,
                    Err(_) => {
                        search.result.skipped += 1;
                        continue;
                    }
                };
                for entry in entries {
                    if search.stopped() {
                        break;
                    }
                    search.entries += 1;
                    let name = entry.file_name();
                    if ignored(&name) {
                        continue;
                    }
                    let meta = entry.metadata();
                    if meta.is_symlink() {
                        continue;
                    }
                    if meta.is_dir() {
                        if depth < MAX_DEPTH {
                            stack.push((entry.path(), depth + 1));
                        } else {
                            search.result.limited = true;
                        }
                        continue;
                    }
                    if !meta.is_regular() {
                        continue;
                    }
                    let path = entry.path();
                    search.name(&path, &name);
                    if search.content {
                        if meta.len() > MAX_FILE {
                            search.result.skipped += 1;
                            continue;
                        }
                        let Ok(mut file) = sftp.open(&path).await else {
                            search.result.skipped += 1;
                            continue;
                        };
                        let mut bytes = Vec::new();
                        let read = (&mut file).take(MAX_FILE + 1).read_to_end(&mut bytes).await;
                        let _ = file.close().await;
                        if read.is_ok() {
                            search.text(&path, &bytes);
                        } else {
                            search.result.skipped += 1;
                        }
                    }
                }
            }
            Ok(())
        };
        let result = tokio::select! {
            result = run => result,
            _ = tokio::time::sleep(DURATION) => Err(AppError::validation("search.timeout")),
            _ = async { while !cancel.load(Ordering::Relaxed) { tokio::time::sleep(Duration::from_millis(40)).await; } } => Err(AppError::validation("search.timeout")),
        };
        let _ = tokio::time::timeout(Duration::from_secs(1), sftp.close()).await;
        result
    };
    match result {
        Ok(()) => Ok(search.result),
        Err(AppError::Validation(message)) if message == "search.timeout" => {
            search.result.limited = true;
            Ok(search.result)
        }
        Err(error) => Err(error),
    }
}

pub async fn search(
    app: AppHandle,
    request_id: String,
    session_id: Option<String>,
    root: String,
    query: String,
    content: bool,
) -> AppResult<SearchResult> {
    if !valid_id(&request_id)
        || root.is_empty()
        || root.len() > 32768
        || root.contains('\0')
        || query.chars().count() < 2
        || query.len() > 256
    {
        return Err(AppError::validation("search.invalidQuery"));
    }
    if session_id.is_none() && !PathBuf::from(&root).is_absolute() {
        return Err(AppError::validation("search.invalidRoot"));
    }
    let flag = {
        let mut requests = REQUESTS
            .lock()
            .map_err(|_| AppError::internal("search.busy"))?;
        requests.retain(|_, (_, time)| time.elapsed() < Duration::from_secs(30));
        if requests
            .values()
            .filter(|(flag, _)| !flag.load(Ordering::Relaxed))
            .count()
            >= 4
        {
            return Err(AppError::validation("search.busy"));
        }
        if let Some((flag, _)) = requests.get(&request_id) {
            if flag.load(Ordering::Relaxed) {
                return Ok(SearchResult::default());
            }
            return Err(AppError::validation("search.busy"));
        }
        let flag = Arc::new(AtomicBool::new(false));
        requests.insert(request_id.clone(), (flag.clone(), Instant::now()));
        flag
    };
    let state = Search {
        needle: query.to_lowercase(),
        content,
        cancel: flag,
        started: Instant::now(),
        entries: 0,
        bytes: 0,
        result: SearchResult::default(),
    };
    let result = if let Some(session_id) = session_id {
        remote(&app, &session_id, root, state).await
    } else {
        tauri::async_runtime::spawn_blocking(move || local(state, root))
            .await
            .map_err(|error| AppError::internal(error.to_string()))?
    };
    if let Ok(mut requests) = REQUESTS.lock() {
        requests.remove(&request_id);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    fn state(query: &str) -> Search {
        Search {
            needle: query.to_lowercase(),
            content: true,
            cancel: Arc::new(AtomicBool::new(false)),
            started: Instant::now(),
            entries: 0,
            bytes: 0,
            result: SearchResult::default(),
        }
    }
    #[test]
    fn recursive_search_reads_text_and_skips_hidden_build_binary_and_oversized_files() {
        let root = std::env::temp_dir().join(format!("tunnelde-search-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("nested")).unwrap();
        std::fs::create_dir_all(root.join("node_modules")).unwrap();
        std::fs::write(root.join("nested/readme.md"), "heading\n你好 MATCH here\n").unwrap();
        std::fs::write(root.join(".hidden"), "match").unwrap();
        std::fs::write(root.join("node_modules/ignored.txt"), "match").unwrap();
        std::fs::write(root.join("binary.bin"), b"match\0binary").unwrap();
        std::fs::write(root.join("large.txt"), vec![b'a'; MAX_FILE as usize + 1]).unwrap();
        let result = local(state("match"), root.to_string_lossy().into_owned()).unwrap();
        assert_eq!(result.matches.len(), 1);
        assert_eq!(result.matches[0].line, 2);
        assert_eq!(result.matches[0].column, 4);
        assert_eq!(result.skipped, 2);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn result_limit_and_cancellation_stop_before_more_file_content_is_processed() {
        let mut search = state("match");
        search.text("/a", "match\n".repeat(200).as_bytes());
        assert_eq!(search.result.matches.len(), MAX_RESULTS);
        assert!(search.result.limited);
        let mut cancelled = state("match");
        cancelled.cancel.store(true, Ordering::Relaxed);
        cancelled.text("/a", b"match");
        assert!(cancelled.result.matches.is_empty());
        assert!(cancelled.result.limited);
    }
    #[test]
    fn unicode_case_expansions_preserve_source_column() {
        let mut search = state("match");
        search.text("/a", "İ 🦀 match".as_bytes());
        assert_eq!(search.result.matches[0].column, 5);
    }
}
