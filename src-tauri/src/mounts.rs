//! SSHFS transports reuse an authenticated SSH channel. No credentials or
//! unauthenticated local listening sockets are exposed to the mount program.
use crate::{
    error::{AppError, AppResult},
    ssh::SshManager,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Stdio,
};
use tauri::{AppHandle, Manager};
use tokio::{
    process::{Child, Command},
    sync::Mutex,
    task::JoinHandle,
};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MountInfo {
    pub id: String,
    pub owner: String,
    pub session_id: String,
    pub remote_path: String,
    pub mount_point: String,
    pub read_only: bool,
    pub cleanup_error: Option<String>,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MountRequest {
    pub session_id: String,
    pub remote_path: String,
    pub mount_point: String,
    #[serde(default = "readonly")]
    pub read_only: bool,
}
fn readonly() -> bool {
    true
}
struct ActiveMount {
    info: MountInfo,
    generation: u64,
    child: Child,
    bridge: JoinHandle<()>,
}
impl Drop for ActiveMount {
    fn drop(&mut self) {
        self.bridge.abort();
    }
}
#[derive(Default)]
pub struct MountRegistry {
    mounts: Mutex<HashMap<String, ActiveMount>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MountDependencies {
    pub available: bool,
    pub executable: Option<String>,
    pub platform: String,
    pub instructions: String,
    pub documentation: String,
    pub transport: Option<String>,
}
fn executable() -> Option<PathBuf> {
    let names: &[&str] = if cfg!(windows) {
        &["sshfs.exe"]
    } else {
        &["sshfs"]
    };
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    if cfg!(windows) {
        if let Some(root) = std::env::var_os("ProgramFiles") {
            dirs.push(PathBuf::from(root).join("SSHFS-Win/bin"));
        }
    }
    if cfg!(target_os = "macos") {
        dirs.extend([
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/usr/local/bin"),
        ]);
    }
    dirs.iter()
        .flat_map(|dir| names.iter().map(move |name| dir.join(name)))
        .find(|path| path.is_file())
}
pub async fn dependencies() -> MountDependencies {
    let path = executable();
    let driver = if cfg!(windows) {
        std::env::var_os("ProgramFiles(x86)")
            .map(PathBuf::from)
            .is_some_and(|root| root.join("WinFsp").is_dir())
            || std::env::var_os("ProgramFiles")
                .map(PathBuf::from)
                .is_some_and(|root| root.join("WinFsp").is_dir())
    } else if cfg!(target_os = "macos") {
        Path::new("/Library/Filesystems/macfuse.fs").is_dir()
            || Path::new("/Library/Filesystems/fuse-t.fs").is_dir()
    } else {
        Path::new("/dev/fuse").exists()
    };
    // Different SSHFS distributions support different transports. In
    // particular, never fall back to spawning ssh.exe with saved credentials.
    let transport = if let Some(path) = path.as_ref() {
        detect_transport(path).await
    } else {
        None
    };
    let (instructions, documentation) = if cfg!(windows) {
        ("Install WinFsp and SSHFS-Win, then restart Tunnelde. Installation is managed by you; Tunnelde does not install drivers.", "https://github.com/winfsp/sshfs-win")
    } else if cfg!(target_os = "macos") {
        ("Install a compatible macFUSE and SSHFS distribution, approve its system extension if requested, then restart Tunnelde.", "https://github.com/libfuse/sshfs")
    } else {
        ("Install your distribution's sshfs and FUSE packages. Ensure your user can access /dev/fuse.", "https://github.com/libfuse/sshfs")
    };
    let instructions = if path.is_some() && transport.is_none() {
        format!("{instructions} This SSHFS build does not advertise the required passive/stdin transport; choose a compatible build.")
    } else {
        instructions.into()
    };
    MountDependencies {
        available: path.is_some() && driver && transport.is_some(),
        executable: path.map(|p| p.to_string_lossy().into()),
        platform: std::env::consts::OS.into(),
        instructions,
        documentation: documentation.into(),
        transport,
    }
}
fn advertised_transport(help: &str) -> Option<String> {
    ["slave", "passive"]
        .into_iter()
        .find(|option| {
            help.lines().any(|line| {
                let prefix = format!("-o {option}");
                line.trim_start()
                    .strip_prefix(&prefix)
                    .is_some_and(|tail| tail.is_empty() || tail.starts_with(char::is_whitespace))
            })
        })
        .map(str::to_owned)
}
async fn detect_transport(program: &Path) -> Option<String> {
    use tokio::io::AsyncReadExt;
    let probe = async {
        let mut child = command(program)
            .arg("-h")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| std::io::Error::other("missing stdout"))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| std::io::Error::other("missing stderr"))?;
        let mut out = Vec::new();
        let mut err = Vec::new();
        let mut stdout = stdout.take(32769);
        let mut stderr = stderr.take(32769);
        tokio::try_join!(
            stdout.read_to_end(&mut out),
            stderr.read_to_end(&mut err),
            child.wait()
        )?;
        if out.len() > 32768 || err.len() > 32768 {
            return Ok(None);
        }
        Ok::<_, std::io::Error>(advertised_transport(&format!(
            "{}\n{}",
            String::from_utf8_lossy(&out),
            String::from_utf8_lossy(&err)
        )))
    };
    tokio::time::timeout(std::time::Duration::from_secs(3), probe)
        .await
        .ok()?
        .ok()?
}
fn command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    let cmd = Command::new(program);
    #[cfg(windows)]
    let cmd = {
        let mut cmd = cmd;
        cmd.creation_flags(0x08000000);
        cmd
    };
    cmd
}

#[cfg(any(target_os = "linux", test))]
fn mounted_in_table(table: &str, mount_point: &str) -> bool {
    table.lines().any(|line| {
        let Some((fields, filesystem)) = line.split_once(" - ") else {
            return false;
        };
        let Some(path) = fields.split_whitespace().nth(4) else {
            return false;
        };
        let path = path
            .replace("\\040", " ")
            .replace("\\011", "\t")
            .replace("\\012", "\n")
            .replace("\\134", "\\");
        path == mount_point
            && filesystem
                .split_whitespace()
                .next()
                .is_some_and(|kind| kind.contains("sshfs"))
    })
}

async fn mount_visible(mount_point: &str) -> AppResult<bool> {
    #[cfg(windows)]
    {
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn GetLogicalDrives() -> u32;
        }
        let letter = mount_point.as_bytes()[0].to_ascii_uppercase() - b'A';
        // SAFETY: GetLogicalDrives takes no arguments and returns a drive bitmask.
        return Ok(unsafe { GetLogicalDrives() } & (1 << letter) != 0);
    }
    #[cfg(target_os = "linux")]
    {
        let table = tokio::fs::read_to_string("/proc/self/mountinfo").await?;
        return Ok(mounted_in_table(&table, mount_point));
    }
    #[cfg(target_os = "macos")]
    {
        let output = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            command("/sbin/mount").kill_on_drop(true).output(),
        )
        .await
        .map_err(|_| AppError::validation("mounts.startTimeout"))??;
        let marker = format!(" on {mount_point} (");
        return Ok(output.status.success()
            && String::from_utf8_lossy(&output.stdout)
                .lines()
                .any(|line| line.starts_with("Tunnelde ") && line.contains(&marker)));
    }
    #[allow(unreachable_code)]
    Err(AppError::validation("mounts.dependencies.required"))
}
#[cfg(windows)]
fn dismount_windows(mount_point: &str) -> AppResult<std::fs::File> {
    use std::os::windows::{fs::OpenOptionsExt, io::AsRawHandle};
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn DeviceIoControl(
            device: *mut std::ffi::c_void,
            code: u32,
            input: *const std::ffi::c_void,
            input_size: u32,
            output: *mut std::ffi::c_void,
            output_size: u32,
            returned: *mut u32,
            overlapped: *mut std::ffi::c_void,
        ) -> i32;
    }
    let volume = format!(r"\\.\{}", mount_point.trim_end_matches(['\\', '/']));
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .share_mode(3)
        .open(volume)?;
    for control in [0x00090018_u32, 0x00090020_u32] {
        // FSCTL_LOCK_VOLUME, FSCTL_DISMOUNT_VOLUME
        let mut returned = 0;
        // SAFETY: file owns a live volume handle; both controls have no input or
        // output buffers and execute synchronously with a valid returned pointer.
        let success = unsafe {
            DeviceIoControl(
                file.as_raw_handle(),
                control,
                std::ptr::null(),
                0,
                std::ptr::null_mut(),
                0,
                &mut returned,
                std::ptr::null_mut(),
            )
        };
        if success == 0 {
            return Err(AppError::Io(std::io::Error::last_os_error()));
        }
    }
    Ok(file) // Keep the lock until the owned filesystem process has stopped.
}
fn validate(request: &MountRequest) -> AppResult<()> {
    if !request.remote_path.starts_with('/') || request.remote_path.contains(['\0', '\n', '\r']) {
        return Err(AppError::validation("mounts.remotePath.absoluteRequired"));
    }
    let path = Path::new(&request.mount_point);
    if !path.is_absolute() || request.mount_point.contains(['\0', '\n', '\r']) {
        return Err(AppError::validation("mounts.mountPoint.absoluteRequired"));
    }
    if cfg!(windows) {
        let bytes = request.mount_point.as_bytes();
        if bytes.len() != 3
            || !bytes[0].is_ascii_alphabetic()
            || bytes[1] != b':'
            || !matches!(bytes[2], b'\\' | b'/')
            || path.exists()
        {
            return Err(AppError::validation(
                "mounts.mountPoint.unusedDriveRequired",
            ));
        }
    } else if !path.is_dir() || std::fs::read_dir(path)?.next().is_some() {
        return Err(AppError::validation(
            "mounts.mountPoint.emptyDirectoryRequired",
        ));
    }
    Ok(())
}
impl MountRegistry {
    pub async fn list(&self, owner: Option<&str>) -> Vec<MountInfo> {
        self.mounts
            .lock()
            .await
            .values()
            .filter(|m| owner.is_none_or(|owner| m.info.owner == owner))
            .map(|m| m.info.clone())
            .collect()
    }
    pub async fn mount(
        &self,
        ssh: &SshManager,
        owner: &str,
        generation: u64,
        mut request: MountRequest,
    ) -> AppResult<MountInfo> {
        validate(&request)?;
        let dependencies = dependencies().await;
        if !dependencies.available {
            return Err(AppError::validation("mounts.dependencies.required"));
        }
        if !cfg!(windows) {
            request.mount_point = Path::new(&request.mount_point)
                .canonicalize()?
                .to_string_lossy()
                .into();
        }
        let program = dependencies
            .executable
            .ok_or_else(|| AppError::validation("mounts.dependencies.required"))?;
        let transport = dependencies
            .transport
            .ok_or_else(|| AppError::validation("mounts.dependencies.required"))?;
        // Serialize creation so two plugins cannot reserve the same drive or directory.
        let mut mounts = self.mounts.lock().await;
        if mounts.values().any(|m| {
            if cfg!(windows) {
                m.info
                    .mount_point
                    .eq_ignore_ascii_case(&request.mount_point)
            } else {
                m.info.mount_point == request.mount_point
            }
        }) {
            return Err(AppError::validation("mounts.mountPoint.inUse"));
        }
        let handle = ssh.handle(&request.session_id)?;
        let channel = handle
            .channel_open_session()
            .await
            .map_err(|e| AppError::Ssh(e.to_string()))?;
        channel
            .request_subsystem(true, "sftp")
            .await
            .map_err(|e| AppError::Ssh(e.to_string()))?;
        let mut cmd = command(program);
        cmd.arg(format!("tunnelde:{}", request.remote_path))
            .arg(&request.mount_point)
            .args(["-f", "-o", &transport, "-o", "fsname=Tunnelde"]);
        if request.read_only {
            cmd.args(["-o", "ro"]);
        }
        // An authenticated subsystem is the only transport. Never permit shell
        // expansion, user-provided ssh_command, reconnect, or password options.
        let mut child = cmd
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()?;
        let input = child
            .stdin
            .take()
            .ok_or_else(|| AppError::internal("mounts.stdin"))?;
        let output = child
            .stdout
            .take()
            .ok_or_else(|| AppError::internal("mounts.stdout"))?;
        let bridge = tokio::spawn(async move {
            let (mut remote_read, mut remote_write) = tokio::io::split(channel.into_stream());
            let mut input = input;
            let mut output = output;
            let _ = tokio::try_join!(
                tokio::io::copy(&mut remote_read, &mut input),
                tokio::io::copy(&mut output, &mut remote_write)
            );
        });
        let info = MountInfo {
            id: uuid::Uuid::new_v4().to_string(),
            owner: owner.into(),
            session_id: request.session_id,
            remote_path: request.remote_path,
            mount_point: request.mount_point,
            read_only: request.read_only,
            cleanup_error: None,
        };
        mounts.insert(
            info.id.clone(),
            ActiveMount {
                info: info.clone(),
                generation,
                child,
                bridge,
            },
        );
        // Register before awaiting readiness so cancellation/revocation still owns
        // the process and bridge. A live process alone is not a mounted filesystem.
        let ready = tokio::time::timeout(std::time::Duration::from_secs(15), async {
            loop {
                let active = mounts.get_mut(&info.id).expect("registered mount");
                if active.child.try_wait()?.is_some() || active.bridge.is_finished() {
                    return Err(AppError::validation("mounts.startFailed"));
                }
                if mount_visible(&info.mount_point).await? {
                    return Ok(());
                }
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }
        })
        .await
        .unwrap_or_else(|_| Err(AppError::validation("mounts.startTimeout")));
        drop(mounts);
        if let Err(error) = ready {
            self.stop_resource(&info).await;
            return Err(error);
        }
        Ok(info)
    }
    pub async fn unmount(&self, owner: &str, id: &str, force: bool) -> AppResult<()> {
        let mut mounts = self.mounts.lock().await;
        let active = mounts
            .get_mut(id)
            .ok_or_else(|| AppError::NotFound("mounts.notFound".into()))?;
        if active.info.owner != owner {
            return Err(AppError::validation("mounts.notOwned"));
        }
        if !mount_visible(&active.info.mount_point).await? {
            let _ = active.child.kill().await;
            active.bridge.abort();
            mounts.remove(id);
            return Ok(());
        }
        #[cfg(windows)]
        let _volume_lock = if force {
            None
        } else {
            Some(dismount_windows(&active.info.mount_point)?)
        };
        if !cfg!(windows) {
            let mut cmd = if cfg!(target_os = "macos") {
                let mut cmd = command("diskutil");
                cmd.arg("unmount");
                if force {
                    cmd.arg("force");
                }
                cmd
            } else {
                let mut cmd = command("fusermount3");
                cmd.arg(if force { "-uz" } else { "-u" });
                cmd
            };
            cmd.arg(&active.info.mount_point).kill_on_drop(true);
            let mut output = tokio::time::timeout(std::time::Duration::from_secs(5), cmd.output())
                .await
                .map_err(|_| AppError::validation("mounts.unmountTimeout"))?;
            if cfg!(target_os = "linux")
                && output
                    .as_ref()
                    .is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound)
            {
                output = tokio::time::timeout(
                    std::time::Duration::from_secs(5),
                    command("fusermount")
                        .arg(if force { "-uz" } else { "-u" })
                        .arg(&active.info.mount_point)
                        .kill_on_drop(true)
                        .output(),
                )
                .await
                .map_err(|_| AppError::validation("mounts.unmountTimeout"))?;
            }
            let output = output?;
            if !output.status.success() {
                tracing::warn!(stderr = %String::from_utf8_lossy(&output.stderr).chars().take(2048).collect::<String>(), "SSHFS unmount failed");
                return Err(AppError::validation("mounts.busy"));
            }
        }
        // Only the owned SSHFS process is stopped; other applications are never killed.
        let _ = active.child.kill().await;
        active.bridge.abort();
        mounts.remove(id);
        Ok(())
    }
    pub async fn stop_generation(&self, owner: &str, generation: u64) {
        let selected: Vec<_> = self
            .mounts
            .lock()
            .await
            .values()
            .filter(|m| m.info.owner == owner && m.generation == generation)
            .map(|m| {
                m.bridge.abort();
                m.info.clone()
            })
            .collect();
        for mount in selected {
            self.stop_resource(&mount).await;
        }
    }
    pub async fn stop_before_generation(&self, owner: &str, boundary: u64) {
        let selected: Vec<_> = self
            .mounts
            .lock()
            .await
            .values()
            .filter(|m| m.info.owner == owner && m.generation < boundary)
            .map(|m| {
                m.bridge.abort();
                m.info.clone()
            })
            .collect();
        for mount in selected {
            self.stop_resource(&mount).await;
        }
    }
    async fn stop_resource(&self, mount: &MountInfo) {
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            self.unmount(&mount.owner, &mount.id, false),
        )
        .await
        .unwrap_or_else(|_| Err(AppError::internal("mounts.unmountTimeout")));
        if let Err(error) = result {
            tracing::warn!(%error, mount_id = mount.id, "SSHFS unmount failed; revoking transport");
            // Busy mounts must not keep authenticated access after revocation.
            // Retain a cleanup record so the user can explicitly retry unmount.
            if let Some(active) = self.mounts.lock().await.get_mut(&mount.id) {
                active.bridge.abort();
                let _ = active.child.kill().await;
                active.info.cleanup_error = Some(error.to_string());
            }
        }
    }
    pub async fn stop_session(&self, session: &str) {
        for mount in self
            .mounts
            .lock()
            .await
            .values()
            .filter(|m| m.info.session_id == session)
        {
            mount.bridge.abort();
        }
        for mount in self
            .list(None)
            .await
            .into_iter()
            .filter(|mount| mount.session_id == session)
        {
            self.stop_resource(&mount).await;
        }
    }
    pub async fn reap(&self) {
        let mut mounts = self.mounts.lock().await;
        for mount in mounts.values_mut() {
            if let Ok(Some(status)) = mount.child.try_wait() {
                mount.bridge.abort();
                mount.info.cleanup_error.get_or_insert_with(|| {
                    tracing::debug!(%status, "SSHFS process exited");
                    "mounts.processExited".into()
                });
            } else if mount.bridge.is_finished() && mount.info.cleanup_error.is_none() {
                let _ = mount.child.start_kill();
                mount.info.cleanup_error = Some("mounts.transportClosed".into());
            }
        }
    }
    pub async fn shutdown(&self) {
        for mount in self.list(None).await {
            self.stop_resource(&mount).await;
        }
    }
}

/// UI and Node plugins share precisely the same authorization and owned resources.
#[tauri::command]
pub async fn plugin_mounts_action(
    app: AppHandle,
    plugin_id: String,
    method: String,
    params: serde_json::Value,
) -> AppResult<serde_json::Value> {
    action(app, plugin_id, method, params, None).await
}

pub async fn action(
    app: AppHandle,
    plugin_id: String,
    method: String,
    params: serde_json::Value,
    expected_generation: Option<u64>,
) -> AppResult<serde_json::Value> {
    let state = app.state::<crate::state::AppState>();
    let plugin = state
        .plugins
        .list()
        .await
        .into_iter()
        .find(|p| p.id == plugin_id)
        .ok_or_else(|| AppError::NotFound("plugin.notFound".into()))?;
    let fingerprint =
        crate::plugins::security::fingerprint_async(PathBuf::from(&plugin.path)).await?;
    let policy = &state.plugins.security;
    let lease = policy.lease(&plugin_id, fingerprint, plugin.permissions)?;
    if expected_generation.is_some_and(|generation| generation != lease.generation) {
        return Err(AppError::validation("pluginSecurity.changed"));
    }
    let permission = if matches!(
        method.as_str(),
        "dependencies" | "list" | "documentation" | "browse"
    ) {
        "mounts.read"
    } else {
        "mounts.write"
    };
    policy.authorize(
        &plugin_id,
        &lease.fingerprint,
        &lease.permissions,
        Some(permission),
        Some(lease.generation),
    )?;
    let result = policy
        .guard(&lease, async {
            state.mounts.reap().await;
            match method.as_str() {
                "dependencies" => Ok(serde_json::to_value(dependencies().await)?),
                "list" => Ok(serde_json::to_value(
                    state.mounts.list(Some(&plugin_id)).await,
                )?),
                "browse" => {
                    let session_id = params
                        .get("sessionId")
                        .and_then(|v| v.as_str())
                        .ok_or_else(|| AppError::validation("mounts.session.required"))?;
                    let path = params.get("path").and_then(|v| v.as_str()).unwrap_or("/");
                    if !path.starts_with('/') || path.contains('\0') {
                        return Err(AppError::validation("mounts.remotePath.absoluteRequired"));
                    }
                    let listing =
                        crate::ssh::files::remote_list(&app, session_id, Some(path.into())).await?;
                    Ok(serde_json::to_value(crate::ssh::files::Listing {
                        path: listing.path,
                        entries: listing.entries.into_iter().filter(|e| e.is_dir).collect(),
                    })?)
                }
                "mount" => Ok(serde_json::to_value(
                    state
                        .mounts
                        .mount(
                            &state.ssh,
                            &plugin_id,
                            lease.generation,
                            serde_json::from_value(params.clone())
                                .map_err(|_| AppError::validation("mounts.request.invalid"))?,
                        )
                        .await?,
                )?),
                "unmount" => {
                    let id = params
                        .get("id")
                        .and_then(|v| v.as_str())
                        .ok_or_else(|| AppError::validation("mounts.id.required"))?;
                    state
                        .mounts
                        .unmount(
                            &plugin_id,
                            id,
                            params
                                .get("force")
                                .and_then(|v| v.as_bool())
                                .unwrap_or(false),
                        )
                        .await?;
                    Ok(serde_json::Value::Null)
                }
                "documentation" => {
                    crate::commands::open_external(
                        app.clone(),
                        dependencies().await.documentation,
                    )?;
                    Ok(serde_json::Value::Null)
                }
                "open" => {
                    let id = params
                        .get("id")
                        .and_then(|v| v.as_str())
                        .ok_or_else(|| AppError::validation("mounts.id.required"))?;
                    let record = state
                        .mounts
                        .list(Some(&plugin_id))
                        .await
                        .into_iter()
                        .find(|m| m.id == id)
                        .ok_or_else(|| AppError::NotFound("mounts.notFound".into()))?;
                    crate::commands::open_local_path(app.clone(), record.mount_point)?;
                    Ok(serde_json::Value::Null)
                }
                _ => Err(AppError::validation("plugin.api.unknownMethod")),
            }
        })
        .await;
    // Rehash after async work as a plugin can be replaced while it is running.
    let current =
        match crate::plugins::security::fingerprint_async(PathBuf::from(plugin.path)).await {
            Ok(current) => current,
            Err(error) => {
                state
                    .mounts
                    .stop_generation(&plugin_id, lease.generation)
                    .await;
                return Err(error);
            }
        };
    if current != lease.fingerprint
        || policy
            .authorize(
                &plugin_id,
                &lease.fingerprint,
                &lease.permissions,
                Some(permission),
                Some(lease.generation),
            )
            .is_err()
    {
        state
            .mounts
            .stop_generation(&plugin_id, lease.generation)
            .await;
        return Err(AppError::validation("pluginSecurity.changed"));
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_remote_options_and_relative_paths() {
        let make = |remote: &str| MountRequest {
            session_id: "session".into(),
            remote_path: remote.into(),
            mount_point: "relative".into(),
            read_only: true,
        };
        assert!(validate(&make("-o allow_other")).is_err());
        assert!(validate(&make("/home\n-o allow_other")).is_err());
        assert!(validate(&make("/home")).is_err());
    }
    #[test]
    fn defaults_to_readonly() {
        let request: MountRequest = serde_json::from_value(
            serde_json::json!({"sessionId":"a", "remotePath":"/", "mountPoint":"Z:\\"}),
        )
        .unwrap();
        assert!(request.read_only);
    }
    #[test]
    fn detects_only_the_exact_sshfs_mount_with_escaped_paths() {
        let table = "1 0 0:1 / /media/ssh\\040files rw - fuse.sshfs Tunnelde rw\n2 0 0:2 / /media/local rw - ext4 /dev/sda rw";
        assert!(mounted_in_table(table, "/media/ssh files"));
        assert!(!mounted_in_table(table, "/media/ssh"));
        assert!(!mounted_in_table(table, "/media/local"));
    }
    #[test]
    fn transport_requires_advertised_option_not_incidental_text() {
        assert_eq!(
            advertised_transport("    -o passive   communicate over stdin/stdout"),
            Some("passive".into())
        );
        assert_eq!(
            advertised_transport("-o slave   stdio\n-o passive   stdio"),
            Some("slave".into())
        );
        assert_eq!(
            advertised_transport("supports slave devices\n-o slave_other"),
            None
        );
    }
}
