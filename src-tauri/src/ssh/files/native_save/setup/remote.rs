//! Exact-connection SSH/SFTP operations; no plugin runner or arbitrary runtime fallback.
use super::package::{Package, Verified};
use super::preparation::Prepared;
use crate::{
    error::{AppError, AppResult},
    ssh::{
        files::native_save::{contracts::authority::Platform, journal::setup::Dispatched},
        session::SessionIdentity,
    },
    state::AppState,
};
use russh::ChannelMsg;
use russh_sftp::{
    client::SftpSession,
    protocol::{FileAttributes, OpenFlags, StatusCode},
};
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub(super) struct Remote {
    pub app: AppHandle,
    pub session: String,
    pub identity: SessionIdentity,
}
impl Remote {
    pub fn capture(app: AppHandle, session: String) -> AppResult<Self> {
        let identity = app.state::<AppState>().ssh.identity(&session)?;
        Ok(Self {
            app,
            session,
            identity,
        })
    }
    pub fn verify(&self) -> AppResult<()> {
        if self.app.state::<AppState>().ssh.identity(&self.session)? != self.identity {
            return Err(AppError::validation("editor.nativeAuthorityChanged"));
        }
        Ok(())
    }
    pub async fn sftp(&self) -> AppResult<SftpSession> {
        self.verify()?;
        let value = crate::ssh::files::session(&self.app, &self.session).await?;
        self.verify()?;
        Ok(value)
    }
    async fn command(&self, command: String) -> AppResult<Vec<u8>> {
        self.verify()?;
        let handle = self.app.state::<AppState>().ssh.handle(&self.session)?;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
        let mut channel = tokio::time::timeout_at(deadline, handle.channel_open_session())
            .await
            .map_err(|_| AppError::validation("editor.nativeReconnect"))?
            .map_err(|_| AppError::validation("editor.nativeReconnect"))?;
        let result = tokio::time::timeout_at(deadline, async {
            self.verify()?;
            channel
                .exec(true, command.as_str())
                .await
                .map_err(|_| AppError::validation("editor.nativeReconnect"))?;
            channel
                .eof()
                .await
                .map_err(|_| AppError::validation("editor.nativeReconnect"))?;
            let mut output = Vec::new();
            let mut total: usize = 0;
            let mut code = None;
            while let Some(message) = channel.wait().await {
                match message {
                    ChannelMsg::Data { data } => {
                        total = total.saturating_add(data.len());
                        if total > 8192 {
                            return Err(AppError::validation("editor.nativeProtocolRejected"));
                        }
                        output.extend_from_slice(&data);
                    }
                    ChannelMsg::ExtendedData { data, .. } => {
                        total = total.saturating_add(data.len());
                        if total > 8192 {
                            return Err(AppError::validation("editor.nativeProtocolRejected"));
                        }
                    }
                    ChannelMsg::ExitStatus { exit_status } => {
                        if code.replace(exit_status).is_some() {
                            return Err(AppError::validation("editor.nativeProtocolRejected"));
                        }
                    }
                    ChannelMsg::Close => break,
                    _ => (),
                }
            }
            self.verify()?;
            if code != Some(0) {
                return Err(AppError::validation("editor.nativePlatformUnsupported"));
            }
            Ok(output)
        })
        .await
        .map_err(|_| AppError::validation("editor.nativeReconnect"));
        let _ = tokio::time::timeout(Duration::from_millis(100), channel.close()).await;
        result?
    }
    pub async fn platform(&self) -> AppResult<Package> {
        if let Ok(output) = self.command("uname -s && uname -m".into()).await {
            if let Ok(value) = std::str::from_utf8(&output) {
                let lines: Vec<_> = value.lines().map(str::trim).collect();
                if let [os, arch] = lines.as_slice() {
                    let os = match *os {
                        "Linux" => "linux",
                        "Darwin" => "macos",
                        _ => "unsupported",
                    };
                    let arch = match *arch {
                        "x86_64" | "amd64" => "x86_64",
                        "aarch64" | "arm64" => "aarch64",
                        _ => "unsupported",
                    };
                    if let Ok(package) = Package::select(&format!("{os}-{arch}")) {
                        return Ok(package);
                    }
                }
            }
        }
        let command = crate::ssh::command::remote("powershell.exe", &["-NoLogo".into(), "-NoProfile".into(), "-NonInteractive".into(), "-Command".into(), "if ($env:OS -ne 'Windows_NT') { exit 1 }; [Console]::Write([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture)".into()], None, "windows")?;
        let output = self.command(command).await?;
        if output == b"X64" {
            Package::select("windows-x86_64")
        } else {
            Err(AppError::validation("editor.nativePlatformUnsupported"))
        }
    }
    pub async fn scope_stamp(&self, path: &str, package: Package) -> AppResult<Vec<u8>> {
        let command = match package.platform {
            "linux-x86_64" | "linux-aarch64" => format!("stat -c '%d:%i:%W' -- {}", posix_literal(path)),
            "macos-x86_64" | "macos-aarch64" => format!("stat -f '%d:%i:%B' {}", posix_literal(path)),
            "windows-x86_64" => powershell(&format!("$ErrorActionPreference='Stop'; $p={}; $item=Get-Item -LiteralPath $p -Force; if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {{ exit 1 }}; $id=& fsutil.exe file queryfileid $p; if ($LASTEXITCODE -ne 0) {{ exit 1 }}; $match=[regex]::Match(($id -join ' '),'0x[0-9a-fA-F]+'); if (-not $match.Success) {{ exit 1 }}; [Console]::Write($match.Value+':'+$item.CreationTimeUtc.Ticks)", powershell_literal(path))),
            _ => return Err(AppError::validation("editor.nativePlatformUnsupported")),
        };
        let stamp = self.command(command).await?;
        if stamp.is_empty()
            || stamp.len() > 128
            || !stamp
                .iter()
                .all(|byte| byte.is_ascii_hexdigit() || matches!(byte, b'x' | b':' | b'\n' | b'\r'))
        {
            return Err(AppError::validation("editor.nativeProtocolRejected"));
        }
        Ok(stamp)
    }
    pub async fn inspect_parent(
        &self,
        sftp: &SftpSession,
        path: &str,
        platform: Platform,
    ) -> AppResult<bool> {
        self.verify()?;
        match sftp.symlink_metadata(path).await {
            Ok(metadata) => {
                if !metadata.is_dir()
                    || (platform == Platform::Posix
                        && metadata
                            .permissions
                            .is_none_or(|permissions| permissions & 0o077 != 0))
                {
                    return Err(AppError::validation("editor.nativeInstallPathUnsafe"));
                }
                // No symlink/junction canonical aliases for these reserved containers.
                let actual = sftp
                    .canonicalize(path)
                    .await
                    .map_err(crate::ssh::files::map_sftp)?;
                let actual = actual
                    .strip_prefix('/')
                    .filter(|value| value.as_bytes().get(1) == Some(&b':'))
                    .unwrap_or(&actual);
                if actual != path {
                    return Err(AppError::validation("editor.nativeInstallPathUnsafe"));
                }
                if platform == Platform::Posix {
                    let uid = self
                        .command("id -u".into())
                        .await
                        .map_err(|_| AppError::validation("editor.nativeInstallPathUnsafe"))?;
                    let uid = std::str::from_utf8(&uid)
                        .ok()
                        .and_then(|value| value.trim().parse::<u32>().ok());
                    if uid.is_none() || metadata.uid != uid {
                        return Err(AppError::validation("editor.nativeInstallPathUnsafe"));
                    }
                } else {
                    // Existing Windows containers must already be private to this
                    // account. Never rewrite someone else's ACL to claim ownership.
                    let script = format!("$ErrorActionPreference='Stop'; $p={}; $item=Get-Item -LiteralPath $p -Force; if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {{ exit 1 }}; $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $acl=Get-Acl -LiteralPath $p; if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid -or -not $acl.AreAccessRulesProtected) {{ exit 1 }}; foreach ($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {{ if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin @($sid,'S-1-5-18','S-1-5-32-544')) {{ exit 1 }} }}; [Console]::Write('private')", powershell_literal(path));
                    if self
                        .command(powershell(&script))
                        .await
                        .map_err(|_| AppError::validation("editor.nativeInstallPathUnsafe"))?
                        != b"private"
                    {
                        return Err(AppError::validation("editor.nativeInstallPathUnsafe"));
                    }
                }
                Ok(true)
            }
            Err(russh_sftp::client::error::Error::Status(status))
                if status.status_code == StatusCode::NoSuchFile =>
            {
                Ok(false)
            }
            Err(_) => Err(AppError::validation("editor.nativeInstallPathUnsafe")),
        }
    }
    async fn private_directory(
        &self,
        sftp: &SftpSession,
        path: &str,
        platform: Platform,
        exclusive: bool,
    ) -> AppResult<()> {
        if !exclusive && self.inspect_parent(sftp, path, platform).await? {
            return Ok(());
        }
        self.verify()?;
        if platform == Platform::Windows {
            // DirectorySecurity is applied at exclusive creation, before uploading code.
            let script = format!("$ErrorActionPreference='Stop'; $p={}; if ([IO.Directory]::Exists($p) -or [IO.File]::Exists($p)) {{ exit 1 }}; $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; $acl=New-Object Security.AccessControl.DirectorySecurity; $acl.SetAccessRuleProtection($true,$false); $acl.SetOwner($sid); $rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'); $acl.AddAccessRule($rule); [IO.Directory]::CreateDirectory($p,$acl) | Out-Null", powershell_literal(path));
            self.command(powershell(&script)).await?;
        } else {
            // The SFTP mkdir API cannot set attributes atomically. Use a restrictive
            // umask rather than exposing a directory before a later chmod.
            self.command(format!(
                "umask 077 && mkdir -m 700 -- {}",
                posix_literal(path)
            ))
            .await?;
        }
        self.inspect_parent(sftp, path, platform).await?;
        Ok(())
    }
    pub async fn install(
        &self,
        prepared: &Prepared,
        permit: &Dispatched,
        package: &Verified,
    ) -> AppResult<()> {
        if permit.record().plan != prepared.plan || package.identity() != prepared.plan.package {
            return Err(AppError::validation("editor.nativeChanged"));
        }
        self.verify()?;
        let platform = prepared
            .plan
            .package
            .platform()
            .ok_or_else(|| AppError::validation("editor.nativePlatformUnsupported"))?;
        let sftp = self.sftp().await?;
        let result = tokio::time::timeout(Duration::from_secs(120), async {
            let canonical = sftp
                .canonicalize(&prepared.plan.context.scope)
                .await
                .map_err(crate::ssh::files::map_sftp)?;
            let canonical = canonical
                .strip_prefix('/')
                .filter(|value| value.as_bytes().get(1) == Some(&b':'))
                .unwrap_or(&canonical);
            if canonical != prepared.plan.context.scope {
                return Err(AppError::validation("editor.nativeChanged"));
            }
            self.private_directory(&sftp, &prepared.container, platform, false)
                .await?;
            self.private_directory(&sftp, &prepared.parent, platform, false)
                .await?;
            self.private_directory(&sftp, &prepared.plan.install_directory, platform, true)
                .await?;
            self.verify()?;
            let mut output = sftp
                .open_with_flags_and_attributes(
                    &prepared.plan.selection.executable,
                    OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::EXCLUDE,
                    FileAttributes {
                        permissions: Some(0o700),
                        ..Default::default()
                    },
                )
                .await
                .map_err(|_| AppError::validation("editor.nativeInstallPathUnsafe"))?;
            for chunk in package.bytes().chunks(64 * 1024) {
                self.verify()?;
                output.write_all(chunk).await?;
            }
            output.shutdown().await?;
            self.verify()?;
            // Verify the actual uploaded bytes before executing them. Never truncate,
            // overwrite or delete a path that may belong to another installation.
            let mut input = sftp
                .open(&prepared.plan.selection.executable)
                .await
                .map_err(crate::ssh::files::map_sftp)?;
            let mut bytes = Vec::new();
            (&mut input)
                .take(package.bytes().len() as u64 + 1)
                .read_to_end(&mut bytes)
                .await?;
            input.close().await?;
            if bytes != package.bytes() {
                return Err(AppError::validation("editor.nativePackageInvalid"));
            }
            self.verify()?;
            Ok(())
        })
        .await
        .map_err(|_| AppError::validation("editor.nativeReconnect"))?;
        let _ = sftp.close().await;
        result
    }
}

fn posix_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}
fn powershell_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}
fn powershell(script: &str) -> String {
    use base64::Engine;
    let encoded = base64::engine::general_purpose::STANDARD.encode(
        script
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>(),
    );
    format!("powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand {encoded}")
}
