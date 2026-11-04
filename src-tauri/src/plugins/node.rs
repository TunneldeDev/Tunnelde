//! Discover a real Node executable without changing the user's environment.
//! Managed installs contain only Node: plugins must ship their dependencies.
use std::io::{Cursor, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};
use tokio::io::AsyncReadExt;
use tokio::process::Command;

use super::network::DownloadTask;
use crate::error::{AppError, AppResult};

const MINIMUM_MAJOR: u64 = 22;
const MAX_DOWNLOAD: usize = 150 * 1024 * 1024;
const MAX_EXECUTABLE: u64 = 200 * 1024 * 1024;
const PROBE: &str = "process.stdout.write(JSON.stringify({version:process.versions.node,execPath:process.execPath}))";
#[cfg(test)]
thread_local! { static PROBE_COUNT: std::cell::Cell<usize> = const { std::cell::Cell::new(0) }; }
#[cfg(test)]
pub(super) fn probe_count_for_test() -> usize {
    PROBE_COUNT.with(|count| count.get())
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeRuntimeInfo {
    pub path: Option<String>,
    pub version: Option<String>,
    pub source: Option<String>,
    pub compatible: bool,
    pub minimum_major: u64,
    pub issue: Option<String>,
}

impl NodeRuntimeInfo {
    fn missing(source: Option<&str>, issue: &str) -> Self {
        Self {
            path: None,
            version: None,
            source: source.map(str::to_owned),
            compatible: false,
            minimum_major: MINIMUM_MAJOR,
            issue: Some(issue.to_owned()),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Probe {
    version: String,
    exec_path: String,
}

fn command(program: &Path) -> Command {
    let mut cmd = Command::new(program);
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .env_remove("NODE_OPTIONS")
        .env_remove("NODE_REPL_EXTERNAL_MODULE")
        .kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x08000000);
    cmd
}

async fn output(mut cmd: Command) -> AppResult<String> {
    let run = async {
        let mut child = cmd
            .spawn()
            .map_err(|_| AppError::validation("node.invalidExecutable"))?;
        let mut bytes = Vec::new();
        let mut stdout = child
            .stdout
            .take()
            .ok_or_else(|| AppError::validation("node.invalidExecutable"))?;
        (&mut stdout)
            .take(32 * 1024 + 1)
            .read_to_end(&mut bytes)
            .await?;
        if bytes.len() > 32 * 1024 {
            return Err(AppError::validation("node.invalidExecutable"));
        }
        if !child.wait().await?.success() {
            return Err(AppError::validation("node.invalidExecutable"));
        }
        String::from_utf8(bytes).map_err(|_| AppError::validation("node.invalidExecutable"))
    };
    tokio::time::timeout(Duration::from_secs(4), run)
        .await
        .map_err(|_| AppError::validation("node.probeTimeout"))?
}

fn parse_probe(text: &str, source: &str) -> AppResult<NodeRuntimeInfo> {
    let value: Probe = serde_json::from_str(text.trim())
        .map_err(|_| AppError::validation("node.invalidExecutable"))?;
    let version = Version::parse(&value.version)
        .map_err(|_| AppError::validation("node.invalidExecutable"))?;
    let path = PathBuf::from(value.exec_path);
    if !path.is_absolute() || !path.is_file() {
        return Err(AppError::validation("node.invalidExecutable"));
    }
    let path = path.canonicalize()?;
    let compatible = version.major >= MINIMUM_MAJOR && version.pre.is_empty();
    Ok(NodeRuntimeInfo {
        path: Some(path.to_string_lossy().into_owned()),
        version: Some(version.to_string()),
        source: Some(source.to_owned()),
        compatible,
        minimum_major: MINIMUM_MAJOR,
        issue: (!compatible).then(|| "node.tooOld".to_owned()),
    })
}

async fn probe(path: &Path, source: &str) -> AppResult<NodeRuntimeInfo> {
    #[cfg(test)]
    PROBE_COUNT.with(|count| count.set(count.get() + 1));
    if !path.is_absolute() || !path.is_file() {
        return Err(AppError::validation("node.invalidExecutable"));
    }
    let mut cmd = command(path);
    cmd.arg("--eval").arg(PROBE);
    parse_probe(&output(cmd).await?, source)
}

fn configured(
    environment: Option<std::ffi::OsString>,
    explicit: Option<&Path>,
) -> Option<(PathBuf, &'static str)> {
    environment
        .map(|value| (PathBuf::from(value), "environment"))
        .or_else(|| explicit.map(|path| (path.to_owned(), "explicit")))
}

/// Environment override and manual choice are authoritative; an invalid choice is
/// visible instead of silently running a different executable.
pub async fn detect(data_dir: &Path, explicit: Option<&Path>) -> AppResult<NodeRuntimeInfo> {
    if let Some((path, source)) = configured(std::env::var_os("TUNNELDE_NODE"), explicit) {
        return Ok(probe(&path, source)
            .await
            .unwrap_or_else(|_| NodeRuntimeInfo::missing(Some(source), "node.invalidExecutable")));
    }
    let mut fallback = None;
    #[cfg(windows)]
    {
        let mut seen = std::collections::HashSet::new();
        let mut candidates = path_candidates(std::env::var_os("PATH").as_deref());
        candidates.extend(registry_candidates().await);
        // Stat all PATH entries, but launch only a bounded number of distinct files.
        for (path, source) in candidates.drain(..) {
            let Ok(path) = path.canonicalize() else {
                continue;
            };
            if !seen.insert(path.clone()) {
                continue;
            }
            if seen.len() > 8 {
                break;
            }
            if let Ok(info) = probe(&path, source).await {
                if info.compatible {
                    return Ok(info);
                }
                if fallback.is_none() {
                    fallback = Some(info);
                }
            }
        }
    }
    #[cfg(unix)]
    if let Some(info) = shell_node().await {
        if info.compatible {
            return Ok(info);
        }
        if fallback.is_none() {
            fallback = Some(info);
        }
    }
    if let Some(path) = managed_path(data_dir) {
        if let Ok(info) = probe(&path, "managed").await {
            if info.compatible {
                return Ok(info);
            }
            if fallback.is_none() {
                fallback = Some(info);
            }
        }
    }
    Ok(fallback.unwrap_or_else(|| NodeRuntimeInfo::missing(None, "node.missing")))
}

/// Merely locate a candidate. In particular, do not run an existing Node before
/// the user has consented to using their system runtime.
pub async fn discover(_data_dir: &Path) -> AppResult<NodeRuntimeInfo> {
    #[cfg(windows)]
    let candidate = {
        let mut values = path_candidates(std::env::var_os("PATH").as_deref());
        values.extend(registry_candidates().await);
        values
            .into_iter()
            .find_map(|(path, source)| path.canonicalize().ok().map(|path| (path, source)))
    };
    #[cfg(unix)]
    let candidate = {
        let shell = login_shell().await;
        let mut cmd = command(&shell);
        cmd.args([
            "-ilc",
            "printf '\\n__TUNNELDE_NODE_PATH__'; command -v node",
        ]);
        match output(cmd).await {
            Ok(text) => text
                .lines()
                .find_map(|line| line.strip_prefix("__TUNNELDE_NODE_PATH__"))
                .map(PathBuf::from)
                .filter(|path| path.is_absolute() && path.is_file())
                .and_then(|path| path.canonicalize().ok())
                .map(|path| (path, "shell")),
            Err(_) => None,
        }
    };
    #[cfg(not(any(windows, unix)))]
    let candidate: Option<(PathBuf, &str)> = None;
    let mut info = NodeRuntimeInfo::missing(None, "node.consentRequired");
    if let Some((path, source)) = candidate {
        info.path = Some(path.to_string_lossy().into_owned());
        info.source = Some(source.to_owned());
    }
    Ok(info)
}

/// A manually selected executable is an exact grant. Previously installed app
/// runtimes are private and approved. Existing system runtimes require consent.
pub async fn resolve(
    data_dir: &Path,
    explicit: Option<&Path>,
    allow_system: bool,
) -> AppResult<NodeRuntimeInfo> {
    if let Some(path) = explicit {
        return Ok(probe(path, "explicit").await.unwrap_or_else(|_| {
            NodeRuntimeInfo::missing(Some("explicit"), "node.invalidExecutable")
        }));
    }
    if let Some(path) = managed_path(data_dir) {
        if let Ok(info) = probe(&path, "managed").await {
            if info.compatible {
                return Ok(info);
            }
        }
    }
    if allow_system {
        detect(data_dir, None).await
    } else {
        discover(data_dir).await
    }
}

#[cfg(windows)]
fn path_candidates(path: Option<&std::ffi::OsStr>) -> Vec<(PathBuf, &'static str)> {
    path.map(|value| {
        std::env::split_paths(value)
            .filter(|part| part.is_absolute())
            .map(|part| {
                (
                    part.join(if cfg!(windows) { "node.exe" } else { "node" }),
                    "path",
                )
            })
            .filter(|(path, _)| path.is_file())
            .collect()
    })
    .unwrap_or_default()
}

#[cfg(windows)]
async fn registry_candidates() -> Vec<(PathBuf, &'static str)> {
    // Read UTF-16 directly: reg.exe output uses a locale-dependent code page and
    // loses paths containing Chinese or other non-ASCII account names.
    #[link(name = "advapi32")]
    extern "system" {
        fn RegGetValueW(
            key: *mut std::ffi::c_void,
            subkey: *const u16,
            value: *const u16,
            flags: u32,
            kind: *mut u32,
            data: *mut std::ffi::c_void,
            size: *mut u32,
        ) -> i32;
    }
    let key = 0x80000001u32 as i32 as isize as *mut std::ffi::c_void;
    let subkey: Vec<u16> = "Environment\0".encode_utf16().collect();
    let name: Vec<u16> = "Path\0".encode_utf16().collect();
    let mut buffer = vec![0u16; 32768];
    let mut size = (buffer.len() * 2) as u32;
    // RRF_RT_REG_SZ | RRF_RT_REG_EXPAND_SZ | RRF_NOEXPAND.
    let status = unsafe {
        RegGetValueW(
            key,
            subkey.as_ptr(),
            name.as_ptr(),
            0x10000006,
            std::ptr::null_mut(),
            buffer.as_mut_ptr().cast(),
            &mut size,
        )
    };
    if status != 0 || size as usize > buffer.len() * 2 || size % 2 != 0 {
        return Vec::new();
    }
    buffer.truncate(size as usize / 2);
    if buffer.last() == Some(&0) {
        buffer.pop();
    }
    let Ok(value) = String::from_utf16(&buffer) else {
        return Vec::new();
    };
    let expanded = expand_environment(&value);
    path_candidates(Some(std::ffi::OsStr::new(&expanded)))
        .into_iter()
        .map(|(path, _)| (path, "registry"))
        .collect()
}

#[cfg(test)]
fn registry_path(text: &str) -> Option<String> {
    text.lines().find_map(|line| {
        let line = line.trim();
        let end = line.find(char::is_whitespace)?;
        if !line[..end].eq_ignore_ascii_case("path") {
            return None;
        }
        let rest = line[end..].trim_start();
        let end = rest.find(char::is_whitespace)?;
        if !matches!(&rest[..end], "REG_SZ" | "REG_EXPAND_SZ") {
            return None;
        }
        Some(rest[end..].trim().to_owned())
    })
}

#[cfg(windows)]
fn expand_environment(value: &str) -> String {
    let mut result = String::new();
    let mut rest = value;
    while let Some(start) = rest.find('%') {
        result.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        let Some(end) = after.find('%') else {
            result.push_str(&rest[start..]);
            return result;
        };
        match std::env::var(&after[..end]) {
            Ok(value) => result.push_str(&value),
            Err(_) => result.push_str(&rest[start..start + end + 2]),
        }
        rest = &after[end + 1..];
    }
    result.push_str(rest);
    result
}

#[cfg(unix)]
async fn shell_node() -> Option<NodeRuntimeInfo> {
    let shell = login_shell().await;
    let mut cmd = command(&shell);
    // Constant shell code: no user paths or values are interpolated into it.
    cmd.args(["-ilc", "node --eval 'process.stdout.write(\"\\n__TUNNELDE_NODE__\"+JSON.stringify({version:process.versions.node,execPath:process.execPath})+\"\\n\")'"]);
    let text = output(cmd).await.ok()?;
    let json = text
        .lines()
        .find_map(|line| line.strip_prefix("__TUNNELDE_NODE__"))?;
    let discovered = parse_probe(json, "shell").ok()?;
    probe(Path::new(discovered.path.as_deref()?), "shell")
        .await
        .ok()
}

#[cfg(unix)]
async fn login_shell() -> PathBuf {
    if let Some(value) = std::env::var_os("SHELL") {
        let path = PathBuf::from(value);
        if path.is_absolute() && path.is_file() {
            return path;
        }
    }
    #[cfg(target_os = "linux")]
    if let Ok(user) = std::env::var("USER") {
        let mut cmd = command(Path::new("/usr/bin/getent"));
        cmd.args(["passwd", &user]);
        if let Ok(line) = output(cmd).await {
            if let Some(shell) = line.trim().split(':').nth(6) {
                let path = PathBuf::from(shell);
                if path.is_absolute() && path.is_file() {
                    return path;
                }
            }
        }
    }
    #[cfg(target_os = "macos")]
    if let Ok(user) = std::env::var("USER") {
        if !user.is_empty() && !user.contains('/') {
            let mut cmd = command(Path::new("/usr/bin/dscl"));
            cmd.args([".", "-read", &format!("/Users/{user}"), "UserShell"]);
            if let Ok(line) = output(cmd).await {
                if let Some(shell) = line.trim().strip_prefix("UserShell:") {
                    let path = PathBuf::from(shell.trim());
                    if path.is_absolute() && path.is_file() {
                        return path;
                    }
                }
            }
        }
    }
    PathBuf::from("/bin/sh")
}

fn runtime_root(data_dir: &Path) -> PathBuf {
    data_dir.join("node")
}

fn managed_path(data_dir: &Path) -> Option<PathBuf> {
    let root = runtime_root(data_dir);
    let mut pointer = Vec::new();
    std::fs::File::open(root.join("active.json"))
        .ok()?
        .take(513)
        .read_to_end(&mut pointer)
        .ok()?;
    if pointer.len() > 512 {
        return None;
    }
    let folder: String = serde_json::from_slice(&pointer).ok()?;
    if folder.is_empty()
        || folder.len() > 160
        || !folder
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.'))
    {
        return None;
    }
    let path = root
        .join(folder)
        .join(if cfg!(windows) { "node.exe" } else { "node" });
    let canonical = path.canonicalize().ok()?;
    if !canonical.starts_with(root.canonicalize().ok()?) {
        return None;
    }
    Some(canonical)
}

#[derive(Deserialize)]
struct Release {
    version: String,
    files: Vec<String>,
}

fn platform() -> AppResult<(&'static str, &'static str)> {
    let os = match std::env::consts::OS {
        "windows" => "win",
        "linux" => "linux",
        "macos" => "darwin",
        _ => return Err(AppError::validation("node.unsupportedPlatform")),
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        _ => return Err(AppError::validation("node.unsupportedPlatform")),
    };
    Ok((os, arch))
}

fn select_release(bytes: &[u8], os: &str, arch: &str) -> AppResult<Version> {
    let releases: Vec<Release> =
        serde_json::from_slice(bytes).map_err(|_| AppError::validation("node.invalidMetadata"))?;
    let artifact = match os {
        "win" => format!("win-{arch}-zip"),
        "darwin" => format!("osx-{arch}-tar"),
        _ => format!("{os}-{arch}"),
    };
    releases
        .into_iter()
        .filter(|release| release.files.iter().any(|file| file == &artifact))
        .filter_map(|release| Version::parse(release.version.strip_prefix('v')?).ok())
        .filter(|version| version.major == 24 && version.pre.is_empty() && version.build.is_empty())
        .max()
        .ok_or_else(|| AppError::validation("node.invalidMetadata"))
}

fn checksum(bytes: &[u8], filename: &str) -> AppResult<String> {
    let text =
        std::str::from_utf8(bytes).map_err(|_| AppError::validation("node.invalidChecksum"))?;
    let mut found = None;
    for line in text.lines() {
        let parts: Vec<_> = line.split_whitespace().collect();
        if parts.len() != 2 || parts[1].trim_start_matches('*') != filename {
            continue;
        }
        if found.is_some()
            || parts[0].len() != 64
            || !parts[0].bytes().all(|value| value.is_ascii_hexdigit())
        {
            return Err(AppError::validation("node.invalidChecksum"));
        }
        found = Some(parts[0].to_ascii_lowercase());
    }
    found.ok_or_else(|| AppError::validation("node.invalidChecksum"))
}

fn safe_archive_path(path: &str) -> bool {
    !path.is_empty()
        && !path.contains('\\')
        && !path.contains(':')
        && !path.contains('\0')
        && !path.starts_with('/')
        && path.split('/').all(|part| part != ".." && part != ".")
        && Path::new(path)
            .components()
            .all(|part| matches!(part, Component::Normal(_)))
}

fn copy_executable(mut reader: impl Read, size: u64, destination: &Path) -> AppResult<()> {
    if size == 0 || size > MAX_EXECUTABLE {
        return Err(AppError::validation("node.invalidArchive"));
    }
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)?;
    let copied = std::io::copy(&mut (&mut reader).take(MAX_EXECUTABLE + 1), &mut file)?;
    if copied != size {
        return Err(AppError::validation("node.invalidArchive"));
    }
    file.flush()?;
    file.sync_all()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(std::fs::Permissions::from_mode(0o755))?;
    }
    Ok(())
}

fn extract(
    bytes: &[u8],
    root: &str,
    windows: bool,
    destination: &Path,
    check: impl Fn() -> AppResult<()>,
) -> AppResult<()> {
    let wanted = format!("{root}/{}", if windows { "node.exe" } else { "bin/node" });
    let mut found = false;
    if windows {
        let mut archive = zip::ZipArchive::new(Cursor::new(bytes))
            .map_err(|_| AppError::validation("node.invalidArchive"))?;
        if archive.len() > 20_000 {
            return Err(AppError::validation("node.invalidArchive"));
        }
        for index in 0..archive.len() {
            check()?;
            let mut entry = archive
                .by_index(index)
                .map_err(|_| AppError::validation("node.invalidArchive"))?;
            if !safe_archive_path(entry.name()) {
                return Err(AppError::validation("node.invalidArchive"));
            }
            if entry.name() != wanted {
                continue;
            }
            if found
                || entry.is_dir()
                || entry
                    .unix_mode()
                    .is_some_and(|mode| mode & 0o170000 != 0 && mode & 0o170000 != 0o100000)
            {
                return Err(AppError::validation("node.invalidArchive"));
            }
            let size = entry.size();
            copy_executable(&mut entry, size, destination)?;
            found = true;
        }
    } else {
        let decoder = flate2::read::GzDecoder::new(Cursor::new(bytes));
        let mut archive = tar::Archive::new(decoder.take(1024 * 1024 * 1024));
        let entries = archive
            .entries()
            .map_err(|_| AppError::validation("node.invalidArchive"))?;
        for (index, entry) in entries.enumerate() {
            check()?;
            if index >= 20_000 {
                return Err(AppError::validation("node.invalidArchive"));
            }
            let mut entry = entry.map_err(|_| AppError::validation("node.invalidArchive"))?;
            let path = entry
                .path()
                .map_err(|_| AppError::validation("node.invalidArchive"))?
                .to_string_lossy()
                .into_owned();
            if !safe_archive_path(&path) {
                return Err(AppError::validation("node.invalidArchive"));
            }
            if path != wanted {
                continue;
            }
            if found || !entry.header().entry_type().is_file() {
                return Err(AppError::validation("node.invalidArchive"));
            }
            let size = entry.size();
            copy_executable(&mut entry, size, destination)?;
            found = true;
        }
    }
    check()?;
    if !found {
        return Err(AppError::validation("node.invalidArchive"));
    }
    Ok(())
}

struct Stage(PathBuf);
impl Drop for Stage {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn activate(root: &Path, stage: &Path, folder: &str) -> AppResult<()> {
    let final_dir = root.join(folder);
    std::fs::rename(stage, &final_dir)?;
    let pointer = root.join(format!(".active-{}.json", uuid::Uuid::new_v4()));
    let result = (|| -> AppResult<()> {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&pointer)?;
        file.write_all(&serde_json::to_vec(folder)?)?;
        file.sync_all()?;
        std::fs::rename(&pointer, root.join("active.json"))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(pointer);
        let _ = std::fs::remove_dir_all(final_dir);
    }
    result
}

/// Installs only after the caller's explicit confirmation; no automatic download.
pub async fn install(app: &AppHandle, task_id: &str) -> AppResult<NodeRuntimeInfo> {
    static INSTALL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _lock = INSTALL
        .try_lock()
        .map_err(|_| AppError::validation("market.busy"))?;
    let task = Arc::new(DownloadTask::begin(app, task_id)?);
    let (os, arch) = platform()?;
    task.progress("metadata", 0, None);
    let metadata = task
        .download("https://nodejs.org/dist/index.json", 4 * 1024 * 1024)
        .await?;
    let version = select_release(&metadata, os, arch)?;
    let archive_root = format!("node-v{version}-{os}-{arch}");
    let filename = format!(
        "{archive_root}.{}",
        if os == "win" { "zip" } else { "tar.gz" }
    );
    let base = format!("https://nodejs.org/dist/v{version}");
    task.progress("checksum", 0, None);
    let sums = task
        .download(&format!("{base}/SHASUMS256.txt"), 128 * 1024)
        .await?;
    let expected = checksum(&sums, &filename)?;
    let bytes = task
        .download(&format!("{base}/{filename}"), MAX_DOWNLOAD)
        .await?;
    task.progress("verifying", 0, None);
    if format!("{:x}", Sha256::digest(&bytes)) != expected {
        return Err(AppError::validation("node.checksumMismatch"));
    }
    task.check()?;
    let data_dir = app
        .state::<crate::state::AppState>()
        .storage
        .dir(crate::storage::layout::Category::Runtimes)
        .to_owned();
    let root = runtime_root(&data_dir);
    std::fs::create_dir_all(&root)?;
    let stage = Stage(root.join(format!(".stage-{}", uuid::Uuid::new_v4())));
    std::fs::create_dir(&stage.0)?;
    let executable = stage.0.join(if os == "win" { "node.exe" } else { "node" });
    task.progress("extracting", 0, None);
    let target = executable.clone();
    let checker = task.clone();
    tokio::task::spawn_blocking(move || {
        extract(&bytes, &archive_root, os == "win", &target, || {
            checker.check()
        })
    })
    .await
    .map_err(|_| AppError::validation("node.invalidArchive"))??;
    let mut info = probe(&executable, "managed").await?;
    if !info.compatible || info.version.as_deref() != Some(version.to_string().as_str()) {
        return Err(AppError::validation("node.invalidExecutable"));
    }
    task.check()?;
    task.progress("activating", 0, None);
    let folder = format!("node-v{version}-{os}-{arch}-{}", uuid::Uuid::new_v4());
    activate(&root, &stage.0, &folder)?;
    info.path = Some(
        root.join(folder)
            .join(if os == "win" { "node.exe" } else { "node" })
            .to_string_lossy()
            .into_owned(),
    );
    task.progress("complete", 1, Some(1));
    Ok(info)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn temp() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tunnelde-node-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        dir
    }
    #[tokio::test]
    async fn consent_is_required_before_any_system_node_probe() {
        let dir = temp();
        PROBE_COUNT.with(|count| count.set(0));
        let info = resolve(&dir, None, false).await.unwrap();
        assert!(!info.compatible);
        assert_eq!(info.version, None);
        assert_eq!(info.issue.as_deref(), Some("node.consentRequired"));
        assert_eq!(PROBE_COUNT.with(|count| count.get()), 0);
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn explicit_environment_override_has_first_priority() {
        let chosen = configured(
            Some("environment-node".into()),
            Some(Path::new("manual-node")),
        )
        .unwrap();
        assert_eq!(chosen, (PathBuf::from("environment-node"), "environment"));
        assert_eq!(
            configured(None, Some(Path::new("manual-node"))).unwrap().1,
            "explicit"
        );
        assert!(configured(None, None).is_none());
    }
    #[test]
    fn parses_actual_executable_and_requires_node_22() {
        let executable = std::env::current_exe().unwrap();
        let parse = |version: &str| {
            parse_probe(
                &serde_json::json!({"version":version,"execPath":executable}).to_string(),
                "path",
            )
            .unwrap()
        };
        assert!(parse("22.0.0").compatible);
        assert!(parse("24.9.0").compatible);
        assert!(!parse("20.19.0").compatible);
        assert!(!parse("24.0.0-rc.1").compatible);
        assert!(parse_probe(r#"{"version":"24.1.0","execPath":"relative"}"#, "path").is_err());
    }
    #[test]
    fn chooses_latest_24_patch_for_available_platform() {
        let bytes = br#"[{"version":"v24.2.1","files":["win-x64-zip"]},{"version":"v26.0.0","files":["win-x64-zip"]},{"version":"v24.12.0","files":["linux-arm64"]},{"version":"v24.2.9","files":["win-x64-zip"]},{"version":"v24.3.0-rc.1","files":["win-x64-zip"]}]"#;
        assert_eq!(
            select_release(bytes, "win", "x64").unwrap().to_string(),
            "24.2.9"
        );
        assert_eq!(
            select_release(bytes, "linux", "arm64").unwrap().to_string(),
            "24.12.0"
        );
        assert!(select_release(bytes, "darwin", "x64").is_err());
    }
    #[test]
    fn checksum_requires_exact_filename_and_valid_unique_hash() {
        let hash = "a".repeat(64);
        assert_eq!(
            checksum(format!("{hash}  node.zip\n").as_bytes(), "node.zip").unwrap(),
            hash
        );
        assert!(checksum(format!("{hash}  other-node.zip\n").as_bytes(), "node.zip").is_err());
        assert!(checksum(b"abcd node.zip", "node.zip").is_err());
        assert!(checksum(
            format!("{hash} node.zip\n{hash} node.zip").as_bytes(),
            "node.zip"
        )
        .is_err());
    }
    #[test]
    fn archive_paths_reject_traversal_and_platform_prefixes() {
        for path in [
            "../node",
            "/root/node",
            "C:/node",
            "node/../bin/node",
            "node\\node.exe",
            "./node",
        ] {
            assert!(!safe_archive_path(path), "{path}");
        }
        assert!(safe_archive_path("node-v24.1.0/bin/node"));
        assert!(safe_archive_path("node-v24.1.0/"));
    }
    #[test]
    fn registry_path_supports_spaces_and_expandable_values() {
        assert_eq!(registry_path("HKEY_CURRENT_USER\\Environment\n    Path    REG_EXPAND_SZ    C:\\Program Files\\nodejs;%APPDATA%\\npm\n").as_deref(), Some("C:\\Program Files\\nodejs;%APPDATA%\\npm"));
        assert!(registry_path("Other REG_SZ C:\\node").is_none());
    }
    fn zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for (name, data) in entries {
            writer
                .start_file(*name, zip::write::SimpleFileOptions::default())
                .unwrap();
            writer.write_all(data).unwrap();
        }
        writer.finish().unwrap().into_inner()
    }
    #[test]
    fn zip_extracts_only_runtime_and_rejects_unsafe_paths() {
        let dir = temp();
        let bytes = zip(&[
            ("node-v24.1.0-win-x64/node.exe", b"runtime"),
            ("node-v24.1.0-win-x64/npm.cmd", b"ignored"),
        ]);
        extract(
            &bytes,
            "node-v24.1.0-win-x64",
            true,
            &dir.join("node.exe"),
            || Ok(()),
        )
        .unwrap();
        assert_eq!(std::fs::read(dir.join("node.exe")).unwrap(), b"runtime");
        assert!(!dir.join("npm.cmd").exists());
        let malicious = zip(&[("../escape", b"bad")]);
        assert!(extract(&malicious, "root", true, &dir.join("other"), || Ok(())).is_err());
        assert!(extract(
            &bytes,
            "node-v24.1.0-win-x64",
            true,
            &dir.join("cancelled"),
            || Err(AppError::validation("market.cancelled"))
        )
        .is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn tar_ignores_package_links_but_never_accepts_a_link_as_runtime() {
        fn archive(runtime_link: bool) -> Vec<u8> {
            let encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
            let mut tar = tar::Builder::new(encoder);
            let mut link = tar::Header::new_gnu();
            link.set_entry_type(tar::EntryType::Symlink);
            link.set_size(0);
            link.set_mode(0o777);
            link.set_link_name("../lib/node_modules/npm/bin/npm-cli.js")
                .unwrap();
            link.set_cksum();
            tar.append_data(
                &mut link,
                "node-v24.1.0-linux-x64/bin/npm",
                std::io::empty(),
            )
            .unwrap();
            let mut header = tar::Header::new_gnu();
            header.set_mode(0o755);
            header.set_size(if runtime_link { 0 } else { 7 });
            if runtime_link {
                header.set_entry_type(tar::EntryType::Symlink);
                header.set_link_name("/outside/node").unwrap();
            } else {
                header.set_entry_type(tar::EntryType::Regular);
            }
            header.set_cksum();
            tar.append_data(
                &mut header,
                "node-v24.1.0-linux-x64/bin/node",
                if runtime_link {
                    &b""[..]
                } else {
                    &b"runtime"[..]
                },
            )
            .unwrap();
            tar.into_inner().unwrap().finish().unwrap()
        }
        let dir = temp();
        extract(
            &archive(false),
            "node-v24.1.0-linux-x64",
            false,
            &dir.join("node"),
            || Ok(()),
        )
        .unwrap();
        assert_eq!(std::fs::read(dir.join("node")).unwrap(), b"runtime");
        assert!(extract(
            &archive(true),
            "node-v24.1.0-linux-x64",
            false,
            &dir.join("link"),
            || Ok(())
        )
        .is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn activation_updates_pointer_without_replacing_previous_runtime() {
        let dir = temp();
        let root = runtime_root(&dir);
        std::fs::create_dir_all(&root).unwrap();
        for name in ["old", "new"] {
            let stage = root.join(format!("stage-{name}"));
            std::fs::create_dir(&stage).unwrap();
            std::fs::write(
                stage.join(if cfg!(windows) { "node.exe" } else { "node" }),
                name,
            )
            .unwrap();
            activate(&root, &stage, name).unwrap();
        }
        assert!(managed_path(&dir)
            .unwrap()
            .starts_with(root.join("new").canonicalize().unwrap()));
        assert!(root.join("old").is_dir());
        std::fs::write(root.join("active.json"), br#""../escape""#).unwrap();
        assert!(managed_path(&dir).is_none());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
