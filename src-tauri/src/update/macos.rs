//! Validate the native bundle as well as the updater signature before replacing it.
use std::ffi::OsStr;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use super::Capability;
use crate::error::{AppError, AppResult};

fn failure(key: &str) -> AppError {
    AppError::Update(key.into())
}

fn bundle_for(executable: &Path) -> Option<&Path> {
    let macos = executable.parent()?;
    let contents = macos.parent()?;
    let bundle = contents.parent()?;
    (macos.file_name()? == "MacOS"
        && contents.file_name()? == "Contents"
        && bundle.extension()? == "app")
        .then_some(bundle)
}

fn writable(path: &Path) -> bool {
    rustix::fs::access(
        path,
        rustix::fs::Access::WRITE_OK | rustix::fs::Access::EXEC_OK,
    )
    .is_ok()
}

fn native_output(
    stage: &'static str,
    invalid: &'static str,
    command: &mut Command,
) -> AppResult<Vec<u8>> {
    native_output_with_budget(stage, invalid, command, Duration::from_secs(10))
}

fn native_output_with_budget(
    stage: &'static str,
    invalid: &'static str,
    command: &mut Command,
    budget: Duration,
) -> AppResult<Vec<u8>> {
    use std::io::Read;
    let mut child = command.stdout(Stdio::piped()).stderr(Stdio::null()).spawn().map_err(|error| {
        tracing::warn!(stage, kind = ?error.kind(), os_error = error.raw_os_error(), "macOS update validation helper could not start");
        failure("updates.macValidationFailed")
    })?;
    let result = (|| {
        let mut stdout = child.stdout.take().unwrap();
        let flags = rustix::fs::fcntl_getfl(&stdout).map_err(std::io::Error::from)?;
        rustix::fs::fcntl_setfl(&stdout, flags | rustix::fs::OFlags::NONBLOCK)
            .map_err(std::io::Error::from)?;
        let deadline = Instant::now() + budget;
        let mut bytes = Vec::new();
        loop {
            let status = child.try_wait()?;
            // Drain while the helper runs so a full pipe cannot stall it. Both
            // reading and waiting are bounded, including inherited open pipes.
            let remaining = 4097_u64.saturating_sub(bytes.len() as u64);
            match (&mut stdout).take(remaining).read_to_end(&mut bytes) {
                Ok(_) => (),
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => (),
                Err(error) => return Err(error.into()),
            }
            if bytes.len() > 4096 {
                tracing::warn!(
                    stage,
                    reason = invalid,
                    "macOS update validation helper exceeded output limit"
                );
                return Err(failure(invalid));
            }
            if let Some(status) = status {
                if !status.success() {
                    tracing::warn!(
                        stage,
                        exit_code = status.code(),
                        reason = invalid,
                        action = "open_update_details_or_output",
                        "macOS update validation rejected the bundle"
                    );
                    return Err(failure(invalid));
                }
                return Ok(bytes);
            }
            if Instant::now() >= deadline {
                tracing::warn!(
                    stage,
                    reason = "updates.timeout",
                    action = "retry_update_or_open_output",
                    "macOS update validation helper timed out"
                );
                return Err(failure("updates.timeout"));
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    })();
    // Reap on every failure, including IO errors, so validation cannot leak helpers.
    if result.is_err() {
        let _ = child.kill();
    }
    let _ = child.wait();
    result
}

fn verify_code_signature(bundle: &Path, stage: &'static str) -> AppResult<()> {
    native_output(
        stage,
        "updates.invalidMacBundle",
        Command::new("/usr/bin/codesign")
            .args(["--verify", "--deep", "--strict"])
            .arg(bundle),
    )
    .map(|_| ())
}

pub(super) fn capability() -> Capability {
    let reason = match std::env::current_exe() {
        Ok(executable) => install_location(&executable).err().unwrap_or(""),
        Err(_) => "location",
    };
    Capability {
        supported: true,
        auto_install: reason.is_empty(),
        reason,
    }
}

fn install_location(executable: &Path) -> Result<(), &'static str> {
    let bundle = bundle_for(executable).ok_or("location")?;
    if bundle
        .components()
        .any(|part| part.as_os_str() == "AppTranslocation")
        || !writable(bundle)
        || !bundle.parent().is_some_and(writable)
    {
        return Err("location");
    }
    Ok(())
}

#[derive(Debug)]
struct Staging(PathBuf);
impl Staging {
    #[cfg(test)]
    fn new() -> AppResult<Self> {
        Self::in_directory(&std::env::temp_dir())
    }
    fn in_directory(parent: &Path) -> AppResult<Self> {
        use std::os::unix::fs::DirBuilderExt;
        let path = parent.join(format!(".tunnelde-update-{}", uuid::Uuid::new_v4()));
        std::fs::DirBuilder::new().mode(0o700).create(&path)?;
        Ok(Self(path))
    }
}
impl Drop for Staging {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn plist(bundle: &Path, field: &str) -> AppResult<String> {
    let stage = match field {
        "CFBundleIdentifier" => "package-identifier",
        "CFBundleShortVersionString" => "package-version",
        _ => "package-executable",
    };
    let output = native_output(
        stage,
        "updates.invalidMacBundle",
        Command::new("/usr/libexec/PlistBuddy")
            .args(["-c", &format!("Print :{field}")])
            .arg(bundle.join("Contents/Info.plist")),
    )?;
    String::from_utf8(output)
        .map(|value| value.trim().to_owned())
        .map_err(|_| failure("updates.invalidMacBundle"))
}

/// Called only after Update::verify authenticates the exact package bytes. This
/// validates native metadata; the stock installer verifies the same bytes again
/// and owns same-volume staging, atomic exchange, rollback and OS interaction.
pub(super) fn validate_package(
    bytes: &[u8],
    identifier: &str,
    version: &str,
    executable_name: &OsStr,
) -> AppResult<()> {
    let staging = Staging::in_directory(&std::env::temp_dir())?;
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(bytes));
    let mut root = None;
    let mut size = 0_u64;
    for (count, entry) in archive.entries()?.enumerate() {
        let mut entry = entry?;
        size = size.saturating_add(entry.size());
        if count >= 100_000 || size > 1024 * 1024 * 1024 {
            return Err(failure("updates.invalidMacBundle"));
        }
        let path = entry.path()?.into_owned();
        let mut parts = path.components();
        let Some(Component::Normal(name)) = parts.next() else {
            return Err(failure("updates.invalidMacBundle"));
        };
        if Path::new(name).extension() != Some(OsStr::new("app"))
            || root.as_ref().is_some_and(|root| root != name)
            || parts.any(|part| !matches!(part, Component::Normal(_)))
            || !(entry.header().entry_type().is_file() || entry.header().entry_type().is_dir())
        {
            // Release bundles contain regular files and directories. Refuse link
            // entries rather than follow them during native validation/extraction.
            return Err(failure("updates.invalidMacBundle"));
        }
        root = Some(name.to_owned());
        if !entry.unpack_in(&staging.0)? {
            return Err(failure("updates.invalidMacBundle"));
        }
    }
    let bundle = staging
        .0
        .join(root.ok_or_else(|| failure("updates.invalidMacBundle"))?);
    if plist(&bundle, "CFBundleIdentifier")? != identifier
        || plist(&bundle, "CFBundleShortVersionString")? != version
        || OsStr::new(&plist(&bundle, "CFBundleExecutable")?) != executable_name
    {
        tracing::warn!(
            stage = "package-metadata",
            reason = "updates.invalidMacBundle",
            action = "open_update_details_or_output",
            "macOS update bundle identity, version or executable does not match"
        );
        return Err(failure("updates.invalidMacBundle"));
    }
    verify_code_signature(&bundle, "package-code-signature")?;
    let architecture = if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        "x86_64"
    };
    native_output(
        "package-architecture",
        "updates.macArchitectureMismatch",
        Command::new("/usr/bin/lipo")
            .arg(bundle.join("Contents/MacOS").join(executable_name))
            .args(["-verify_arch", architecture]),
    )?;
    Ok(())
}

pub(super) fn validate_current(executable: &Path) -> AppResult<()> {
    install_location(executable).map_err(|_| failure("updates.macInstallLocation"))?;
    let bundle = bundle_for(executable).ok_or_else(|| failure("updates.macInstallLocation"))?;
    verify_code_signature(bundle, "installed-code-signature")
}

#[cfg(test)]
mod tests;
