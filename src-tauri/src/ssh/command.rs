//! Shared shell encoding for explicit SSH programs; arguments remain data.
use crate::error::{AppError, AppResult};

pub(crate) fn remote(
    executable: &str,
    args: &[String],
    cwd: Option<&str>,
    platform: &str,
) -> AppResult<String> {
    if platform == "windows" {
        let quote = |value: &str| format!("'{}'", value.replace('\'', "''"));
        let mut script = String::from("$ErrorActionPreference='Stop'; ");
        if let Some(cwd) = cwd {
            script.push_str(&format!("Set-Location -LiteralPath {}; ", quote(cwd)));
        }
        script.push_str(&format!(
            "& {} {}; exit $LASTEXITCODE",
            quote(executable),
            args.iter()
                .map(|arg| quote(arg))
                .collect::<Vec<_>>()
                .join(" ")
        ));
        use base64::Engine;
        let encoded = base64::engine::general_purpose::STANDARD.encode(
            script
                .encode_utf16()
                .flat_map(u16::to_le_bytes)
                .collect::<Vec<_>>(),
        );
        Ok(format!(
            "powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand {encoded}"
        ))
    } else if platform == "posix" {
        let quote = |value: &str| format!("'{}'", value.replace('\'', "'\"'\"'"));
        let prefix = cwd
            .map(|cwd| format!("cd {} && ", quote(cwd)))
            .unwrap_or_default();
        Ok(format!(
            "{prefix}exec {} {}",
            quote(executable),
            args.iter()
                .map(|arg| quote(arg))
                .collect::<Vec<_>>()
                .join(" ")
        ))
    } else {
        Err(AppError::validation("plugin.tasks.invalidPlatform"))
    }
}
