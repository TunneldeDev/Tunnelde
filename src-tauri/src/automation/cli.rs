//! Console entry point for programs and interactive shells. Never launches a webview.
use super::{client::exchange, contract::*, transport};
use serde_json::Value;
use std::{
    ffi::OsString,
    io::{Read, Write},
    path::PathBuf,
};

const HELP: &str = "Tunnelde CLI\n\
Usage: tunnelde-cli [--endpoint PATH] <command>\n\
       tunnelde cli [--endpoint PATH] <command>\n\
  --version                 Print the CLI build version (offline)\n\
  api describe              Print this CLI's API schema (offline)\n\
  app info                  Read the running application's version\n\
  hosts list                List saved hosts without credentials\n\
  sessions list             List currently connected sessions\n\
  preferences schema        Describe public settings\n\
  preferences snapshot      Read public settings and their revision\n\
  preferences update --params JSON|-  Save settings with the original revision\n\
  call METHOD [--params JSON|-]  Call a discovered local API method\n\
The application must be running for live calls. TUNNELDE_ENDPOINT can select\n\
an isolated application's automation.json. Output is JSON. Errors are JSON\n\
on stderr. Exit codes: 0 success, 1 operation failed, 2 invalid input,\n\
3 unavailable/timeout, 4 authentication failed, 5 stale revision.\n";

enum Command {
    Help,
    Version,
    Describe,
    Call {
        endpoint: Option<PathBuf>,
        method: String,
        params: Value,
    },
}

/// The shipped desktop executable also handles CLI calls before Tauri or the
/// single-instance plugin starts, so it works with the installer as delivered.
pub fn from_desktop() -> Option<i32> {
    let mut arguments = std::env::args_os().skip(1);
    if arguments.next().is_none_or(|argument| argument != "cli") {
        return None;
    }
    #[cfg(windows)]
    attach_console();
    Some(run(arguments))
}

#[cfg(windows)]
fn attach_console() {
    use windows_sys::Win32::{Foundation::INVALID_HANDLE_VALUE, System::Console::*};
    // Preserve redirected handles when launched by another program. GUI Windows
    // processes otherwise have no console, so attach to the invoking shell.
    // SAFETY: GetStdHandle borrows a process handle; AttachConsole takes an id.
    unsafe {
        let output = GetStdHandle(STD_OUTPUT_HANDLE);
        if output.is_null() || output == INVALID_HANDLE_VALUE {
            AttachConsole(ATTACH_PARENT_PROCESS);
        }
    }
}

/// Suitable for a console binary; does not initialize Tauri, SQLite or plugins.
pub fn run(arguments: impl IntoIterator<Item = OsString>) -> i32 {
    let result = parse(arguments.into_iter().collect()).and_then(|command| match command {
        Command::Help => Ok((HELP.as_bytes().to_vec(), 0)),
        Command::Version => encode(
            &serde_json::json!({"version": env!("CARGO_PKG_VERSION"), "apiVersion": VERSION}),
        ),
        Command::Describe => encode(&describe()),
        Command::Call {
            endpoint,
            method,
            params,
        } => {
            let pointer = endpoint
                .or_else(|| std::env::var_os("TUNNELDE_ENDPOINT").map(PathBuf::from))
                .or_else(transport::default_pointer)
                .ok_or_else(|| {
                    Failure::new(
                        "unavailable",
                        "Cannot determine application data directory; use --endpoint",
                    )
                })?;
            let endpoint = transport::read_endpoint(&pointer)?;
            let response = exchange(endpoint, method, params)?;
            let status = match &response.outcome {
                Outcome::Success { .. } => 0,
                Outcome::Error { error } => error.exit_code(),
            };
            // Preserve the host's request id on operation errors as well.
            encode(&response).map(|(bytes, _)| (bytes, status))
        }
    });
    match result {
        Ok((mut bytes, status)) => {
            if bytes.last() != Some(&b'\n') {
                bytes.push(b'\n');
            }
            let written = if status == 0 {
                std::io::stdout().lock().write_all(&bytes)
            } else {
                std::io::stderr().lock().write_all(&bytes)
            };
            if written.is_err() {
                return 1;
            }
            status
        }
        Err(error) => {
            let status = error.exit_code();
            let response = Response::new(String::new(), Err(error));
            let mut bytes = serde_json::to_vec(&response).expect("serializable CLI failure");
            bytes.push(b'\n');
            let _ = std::io::stderr().lock().write_all(&bytes);
            status
        }
    }
}

fn encode(value: &impl serde::Serialize) -> Result<(Vec<u8>, i32), Failure> {
    serde_json::to_vec(value)
        .map(|bytes| (bytes, 0))
        .map_err(|_| Failure::new("internal", "Cannot encode CLI output"))
}

fn parse(mut args: Vec<OsString>) -> Result<Command, Failure> {
    let invalid = || {
        Failure::new(
            "invalid_arguments",
            "Invalid arguments; run tunnelde-cli --help",
        )
    };
    let mut endpoint = None;
    if args.first().is_some_and(|arg| arg == "--endpoint") {
        if args.len() < 3 {
            return Err(invalid());
        }
        endpoint = Some(PathBuf::from(args.remove(1)));
        args.remove(0);
    }
    let args: Vec<_> = args
        .into_iter()
        .map(|arg| arg.into_string().map_err(|_| invalid()))
        .collect::<Result<_, _>>()?;
    let tokens: Vec<_> = args.iter().map(String::as_str).collect();
    let (method, params) = match tokens.as_slice() {
        [] | ["--help"] | ["-h"] => return Ok(Command::Help),
        ["--version"] | ["-V"] => return Ok(Command::Version),
        ["api", "describe"] => return Ok(Command::Describe),
        ["app", "info"] => ("app.info", None),
        ["hosts", "list"] => ("hosts.list", None),
        ["sessions", "list"] => ("sessions.list", None),
        ["preferences", "schema"] => ("preferences.schema", None),
        ["preferences", "snapshot"] => ("preferences.snapshot", None),
        ["preferences", "update", "--params", params] => ("preferences.update", Some(*params)),
        ["call", method] => (*method, None),
        ["call", method, "--params", params] => (*method, Some(*params)),
        _ => return Err(invalid()),
    };
    if method.is_empty()
        || method.len() > 128
        || !method
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._".contains(&byte))
    {
        return Err(invalid());
    }
    let params = match params {
        None => serde_json::json!({}),
        Some("-") => {
            let mut bytes = Vec::new();
            std::io::stdin()
                .lock()
                .take((MAX_REQUEST + 1) as u64)
                .read_to_end(&mut bytes)
                .map_err(|_| invalid())?;
            if bytes.len() > MAX_REQUEST {
                return Err(invalid());
            }
            serde_json::from_slice(&bytes).map_err(|_| invalid())?
        }
        Some(text) => {
            if text.len() > MAX_REQUEST {
                return Err(invalid());
            }
            serde_json::from_str(text).map_err(|_| invalid())?
        }
    };
    if !params.is_object() {
        return Err(invalid());
    }
    Ok(Command::Call {
        endpoint,
        method: method.into(),
        params,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn args(input: &[&str]) -> Vec<OsString> {
        input.iter().map(OsString::from).collect()
    }
    #[test]
    fn parsing_never_turns_unknown_input_into_a_gui_launch_or_an_invoke() {
        assert!(
            matches!(parse(args(&["hosts", "list"])).unwrap(), Command::Call { method, .. } if method == "hosts.list")
        );
        assert!(parse(args(&["call", "foo", "--params", "[]"])).is_err());
        assert!(parse(args(&["hosts", "delete", "all"])).is_err());
        assert!(parse(args(&["--endpoint"])).is_err());
        assert!(parse(args(&["call", "../ssh_exec"])).is_err());
        assert!(matches!(
            parse(args(&["api", "describe"])).unwrap(),
            Command::Describe
        ));
    }
}
