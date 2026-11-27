//! Identity-checked remote process actions. No local filesystem paths are used.
use super::super::processes::platform::{self, Platform};
use super::{exec, native_actions};
use crate::error::{AppError, AppResult};
use tauri::AppHandle;

fn guard(pid: u32, start: u64) -> AppResult<String> {
    if pid <= 1 {
        return Err(AppError::Ssh("monitor.killProtected".into()));
    }
    Ok(format!("line=$(cat /proc/{pid}/stat 2>/dev/null); rest=${{line##*) }}; set -- $rest; [ \"${{20}}\" = \"{start}\" ] || {{ echo monitor.processChanged; exit 1; }}; "))
}

fn tree_script(pid: u32, start: u64) -> AppResult<String> {
    let check = guard(pid, start)?;
    let ongoing = check.replace("/stat 2>/dev/null);", "/stat 2>/dev/null) || exit 0;");
    Ok(format!(
        r#"LANG=C
{check}
# Snapshot parent and start identities before signalling anything.
rows=$(for file in /proc/[0-9]*/stat; do
  line=$(cat "$file" 2>/dev/null) || continue
  id=${{line%% *}}; rest=${{line##*) }}; set -- $rest
  printf '%s %s %s\n' "$id" "$2" "${{20}}"
done)
# Never terminate the action channel itself or one of its ancestors.
protected=$(printf '%s\n' "$rows" | awk -v current=$$ '{{p[$1]=$2}} END {{while(current>1 && !seen[current]++) {{print current; current=p[current]}}}}')
tree=$(printf '%s\n' "$rows" | awk -v root={pid} '
{{p[$1]=$2; start[$1]=$3}}
END {{d[root]=1; for(pass=0;pass<length(p);pass++) {{changed=0; for(id in p) if(!d[id] && d[p[id]]) {{d[id]=d[p[id]]+1;changed=1}}; if(!changed)break}}
for(id in d) if(d[id]>0) print d[id],id,p[id],start[id]}}' | sort -rn)
for id in $protected; do
  printf '%s\n' "$tree" | awk -v id="$id" '$2==id {{found=1}} END {{exit !found}}' && {{ echo monitor.killProtected; exit 1; }}
done
printf '%s\n' "$tree" | while read -r depth id parent started; do
  {ongoing}
  line=$(cat /proc/"$id"/stat 2>/dev/null) || continue
  rest=${{line##*) }}; set -- $rest
  [ "${{20}}" = "$started" ] && [ "$2" = "$parent" ] || continue
  failure=$(kill -TERM "$id" 2>&1) || {{ [ ! -r /proc/"$id"/stat ] || {{ printf 'monitor.killFailed: %s\n' "$failure"; exit 1; }}; }}
done
"#
    ))
}

pub(super) fn kill_script(platform: Platform, pid: u32, start: Option<u64>) -> AppResult<String> {
    if pid <= 1 {
        return Err(AppError::Ssh("monitor.killProtected".into()));
    }
    Ok(match platform {
        Platform::Windows => native_actions::win_kill(pid, start),
        Platform::Macos => format!(
            "{}kill -TERM {pid} 2>&1",
            start
                .map(|start| native_actions::mac_guard(pid, start))
                .unwrap_or_default()
        ),
        Platform::Linux => format!(
            "{}kill -TERM {pid} 2>&1",
            start
                .map(|start| guard(pid, start))
                .transpose()?
                .unwrap_or_default()
        ),
    })
}

fn native_tree_script(platform: Platform, pid: u32, start: u64) -> AppResult<String> {
    if pid <= 1 {
        return Err(AppError::Ssh("monitor.killProtected".into()));
    }
    match platform {
        Platform::Linux => tree_script(pid, start),
        Platform::Macos => Ok(native_actions::mac_tree(pid, start)),
        Platform::Windows => Ok(native_actions::win_tree(pid, start)),
    }
}

pub async fn kill_tree(app: &AppHandle, session: &str, pid: u32, start: u64) -> AppResult<()> {
    let platform = platform::detect(app, session).await?;
    let output = exec(app, session, &native_tree_script(platform, pid, start)?).await?;
    if (platform == Platform::Windows && output.trim() == "TUNNELDE_OK")
        || (platform != Platform::Windows && output.trim().is_empty())
    {
        Ok(())
    } else {
        Err(AppError::Ssh(if output.trim().is_empty() {
            "monitor.killFailed".into()
        } else {
            output.trim().to_owned()
        }))
    }
}

fn executable_script(platform: Platform, pid: u32, start: u64) -> AppResult<String> {
    if pid <= 1 {
        return Err(AppError::Ssh("monitor.killProtected".into()));
    }
    Ok(match platform {
        Platform::Linux => {
            let check = guard(pid, start)?;
            format!("{check}path=$(readlink /proc/{pid}/exe 2>/dev/null) || {{ echo monitor.executableUnavailable; exit 1; }}; {check}printf '%s' \"$path\"")
        }
        Platform::Macos => {
            let check = native_actions::mac_guard(pid, start);
            format!("{check}path=$(/usr/sbin/lsof -a -p {pid} -d txt -Fn 2>/dev/null | awk '/^n/ {{print substr($0,2); exit}}'); {check}printf '%s' \"$path\"")
        }
        Platform::Windows => native_actions::win_executable(pid, start),
    })
}

pub async fn executable(app: &AppHandle, session: &str, pid: u32, start: u64) -> AppResult<String> {
    let platform = platform::detect(app, session).await?;
    let output = exec(app, session, &executable_script(platform, pid, start)?).await?;
    executable_path(platform, output)
}

fn executable_path(platform: Platform, output: String) -> AppResult<String> {
    if output.trim() == "monitor.processChanged" {
        return Err(AppError::Ssh("monitor.processChanged".into()));
    }
    let output = if platform == Platform::Windows {
        let path = output.replace('\\', "/");
        if path.as_bytes().get(1) == Some(&b':') {
            format!("/{path}")
        } else {
            path
        }
    } else {
        output
    };
    if !output.starts_with('/')
        || output.contains(['\n', '\r', '\0'])
        || output.ends_with(" (deleted)")
    {
        return Err(AppError::Ssh("monitor.executableUnavailable".into()));
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn protected_processes_never_produce_a_script() {
        assert!(tree_script(0, 1).is_err());
        assert!(tree_script(1, 1).is_err());
    }
    #[test]
    fn tree_checks_start_and_parent_and_protects_channel_ancestors() {
        let script = tree_script(42, 123).unwrap();
        assert!(script.contains("/proc/42/stat"));
        assert!(script.contains("= \"123\""));
        assert!(script.contains("[ \"$2\" = \"$parent\" ]"));
        assert!(script.contains("current=$$"));
        assert!(script.contains("sort -rn"));
    }
}

#[cfg(all(test, target_os = "linux"))]
mod linux_tests {
    use super::*;
    use std::io::{BufRead, BufReader};
    use std::process::{Command, Stdio};
    #[test]
    fn terminates_a_real_child_tree_and_rejects_reused_identity() {
        let mut root = Command::new("sh")
            .args(["-c", "sleep 20 & echo $!; wait"])
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut line = String::new();
        BufReader::new(root.stdout.take().unwrap())
            .read_line(&mut line)
            .unwrap();
        let child: u32 = line.trim().parse().unwrap();
        let pid = root.id();
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).unwrap();
        let start: u64 = stat
            .rsplit_once(") ")
            .unwrap()
            .1
            .split_whitespace()
            .nth(19)
            .unwrap()
            .parse()
            .unwrap();
        let refused = Command::new("sh")
            .args(["-c", &tree_script(pid, start + 1).unwrap()])
            .output()
            .unwrap();
        assert!(String::from_utf8_lossy(&refused.stdout).contains("monitor.processChanged"));
        assert!(root.try_wait().unwrap().is_none());
        let output = Command::new("sh")
            .args(["-c", &tree_script(pid, start).unwrap()])
            .output()
            .unwrap();
        let _ = root.kill();
        let _ = root.wait();
        for _ in 0..100 {
            if std::fs::read_to_string(format!("/proc/{child}/stat"))
                .map(|s| s.rsplit_once(") ").unwrap().1.starts_with('Z'))
                .unwrap_or(true)
            {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        let child_stat = std::fs::read_to_string(format!("/proc/{child}/stat"));
        assert!(
            child_stat
                .as_ref()
                .map(|s| s.rsplit_once(") ").unwrap().1.starts_with('Z'))
                .unwrap_or(true),
            "child remained alive: {child_stat:?}, output: {output:?}"
        );
        assert!(output.stdout.is_empty(), "{output:?}");
    }
}

fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn launch_script(command: &str, cwd: &str) -> AppResult<String> {
    if command.trim().is_empty()
        || command.len() > 16384
        || cwd.len() > 4096
        || command.contains('\0')
        || cwd.contains('\0')
        || (!cwd.is_empty() && !cwd.starts_with('/'))
    {
        return Err(AppError::validation("monitor.invalidTask"));
    }
    let directory = if cwd.is_empty() {
        String::new()
    } else {
        format!(
            "cd -- {} 2>/dev/null || {{ echo monitor.taskDirectory; exit 1; }}; ",
            quote(cwd)
        )
    };
    Ok(format!("{directory}command -v nohup >/dev/null 2>&1 || {{ echo monitor.noNohup; exit 1; }}; nohup sh -c {} </dev/null >/dev/null 2>&1 &\nprintf 'TUNNELDE_PID=%s\\n' \"$!\"", quote(command)))
}

pub async fn launch(app: &AppHandle, session: &str, command: &str, cwd: &str) -> AppResult<u32> {
    if command.trim().is_empty()
        || command.len() > 16384
        || cwd.len() > 4096
        || command.contains('\0')
        || cwd.contains('\0')
    {
        return Err(AppError::validation("monitor.invalidTask"));
    }
    let platform = platform::detect(app, session).await?;
    let script = match platform {
        Platform::Windows => native_actions::win_launch(command, cwd)?,
        _ => launch_script(command, cwd)?,
    };
    let output = exec(app, session, &script).await?;
    output
        .trim()
        .strip_prefix("TUNNELDE_PID=")
        .and_then(|value| value.parse::<u32>().ok())
        .filter(|pid| *pid > 1)
        .ok_or_else(|| AppError::Ssh(format!("monitor.launchFailed: {}", output.trim())))
}

#[cfg(test)]
mod launch_tests {
    use super::*;
    #[test]
    fn rejects_empty_nul_relative_and_oversized_tasks() {
        for (command, cwd) in [
            (" ", ""),
            ("sleep 1", "relative"),
            ("x\0y", "/"),
            ("sleep 1", "/x\0y"),
        ] {
            assert!(launch_script(command, cwd).is_err());
        }
        assert!(launch_script(&"x".repeat(16385), "/").is_err());
    }
    #[test]
    fn shell_arguments_are_quoted_and_background_streams_detached() {
        let script = launch_script("printf '%s' \"$HOME\"", "/tmp/a'$(id)").unwrap();
        assert!(script.contains("cd -- '/tmp/a'\\''$(id)'"));
        assert!(script.contains("</dev/null >/dev/null 2>&1 &"));
        assert!(script.contains("TUNNELDE_PID="));
    }
}
#[cfg(all(test, any(target_os = "linux", target_os = "macos")))]
mod launch_unix_tests {
    use super::*;
    use std::process::Command;
    #[test]
    fn launch_preserves_quoted_directory_and_command() {
        let directory =
            std::env::temp_dir().join(format!("tunnelde task '{}'", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let command = "printf '%s' 'literal $HOME' > result";
        let script = launch_script(command, directory.to_str().unwrap()).unwrap();
        let output = Command::new("sh").args(["-c", &script]).output().unwrap();
        for _ in 0..100 {
            if directory.join("result").exists() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        let result = std::fs::read_to_string(directory.join("result"));
        let _ = std::fs::remove_dir_all(&directory);
        assert!(String::from_utf8_lossy(&output.stdout).starts_with("TUNNELDE_PID="));
        assert_eq!(result.unwrap(), "literal $HOME");
    }
}

#[cfg(test)]
mod native_path_tests {
    use super::*;

    #[test]
    fn windows_executables_are_canonical_sftp_paths() {
        for (raw, expected) in [
            (
                r"C:\Program Files\worker.exe",
                "/C:/Program Files/worker.exe",
            ),
            (r"\\server\share\worker.exe", "//server/share/worker.exe"),
        ] {
            assert_eq!(
                executable_path(Platform::Windows, raw.into()).unwrap(),
                expected
            );
        }
        for raw in [
            "",
            "monitor.executableUnavailable",
            "C:\\bad\npath",
            "C:\\bad\0path",
        ] {
            assert!(executable_path(Platform::Windows, raw.into()).is_err());
        }
        assert!(
            executable_path(Platform::Macos, "monitor.processChanged".into())
                .unwrap_err()
                .to_string()
                .contains("monitor.processChanged")
        );
        for platform in [Platform::Linux, Platform::Macos, Platform::Windows] {
            assert!(kill_script(platform, 1, Some(10)).is_err());
            assert!(native_tree_script(platform, 0, 10).is_err());
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_resolves_real_executable_and_rejects_stale_identity() {
        use std::process::Command;
        let pid = std::process::id();
        let output = Command::new("sh")
            .args(["-c", &format!("id={pid}; {}", native_actions::MAC_START)])
            .output()
            .unwrap();
        let start = String::from_utf8(output.stdout)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        let output = Command::new("sh")
            .args([
                "-c",
                &executable_script(Platform::Macos, pid, start).unwrap(),
            ])
            .output()
            .unwrap();
        let path =
            executable_path(Platform::Macos, String::from_utf8(output.stdout).unwrap()).unwrap();
        assert_eq!(
            std::path::Path::new(&path),
            std::env::current_exe().unwrap()
        );
        let output = Command::new("sh")
            .args([
                "-c",
                &executable_script(Platform::Macos, pid, start + 1).unwrap(),
            ])
            .output()
            .unwrap();
        assert!(
            executable_path(Platform::Macos, String::from_utf8(output.stdout).unwrap()).is_err()
        );
    }
}
