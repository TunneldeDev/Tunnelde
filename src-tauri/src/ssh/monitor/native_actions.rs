//! Native remote actions for macOS and Windows. All identities fit JS safe integers.
use super::super::processes::platform::{powershell, ps_literal};
use crate::error::{AppError, AppResult};

pub(super) const MAC_START: &str = r#"LC_ALL=C ps -p "$id" -o lstart= 2>/dev/null | awk '
BEGIN {split("Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec",m); for(i=1;i<=12;i++) month[m[i]]=i}
NF==5 {split($4,t,":"); printf "%04d%02d%02d%02d%02d%02d\n",$5,month[$2],$3,t[1],t[2],t[3]}'"#;

pub(super) fn mac_guard(pid: u32, start: u64) -> String {
    format!("id={pid}; started=$({MAC_START}); [ \"$started\" = \"{start}\" ] || {{ echo monitor.processChanged; exit 1; }}; ")
}

pub(super) fn mac_tree(pid: u32, start: u64) -> String {
    let guard = mac_guard(pid, start);
    let ongoing = guard.replace(
        "[ \"$started\" =",
        "[ -n \"$started\" ] || exit 0; [ \"$started\" =",
    );
    format!(
        r#"export LC_ALL=C
{guard}
rows=$(ps -axo pid=,ppid=,lstart= | awk '
BEGIN {{split("Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec",m);for(i=1;i<=12;i++) month[m[i]]=i}}
NF==7 {{split($6,t,":");printf "%s %s %04d%02d%02d%02d%02d%02d\n",$1,$2,$7,month[$4],$5,t[1],t[2],t[3]}}')
protected=$(printf '%s\n' "$rows" | awk -v current=$$ '{{p[$1]=$2}} END {{while(current>1 && !seen[current]++) {{print current; current=p[current]}}}}')
tree=$(printf '%s\n' "$rows" | awk -v root={pid} '
{{p[$1]=$2; start[$1]=$3}}
END {{d[root]=1; for(pass=0;pass<length(p);pass++) {{changed=0; for(id in p) if(!d[id] && d[p[id]]) {{d[id]=d[p[id]]+1;changed=1}}; if(!changed)break}}
for(id in d) if(d[id]>0) print d[id],id,p[id],start[id]}}' | sort -rn)
for id in $protected; do
  printf '%s\n' "$tree" | awk -v id="$id" '$2==id {{found=1}} END {{exit !found}}' && {{ echo monitor.killProtected; exit 1; }}
done
printf '%s\n' "$tree" | while read -r depth target parent expected; do
  {ongoing}
  id=$target; started=$({MAC_START})
  [ "$started" = "$expected" ] || continue
  current_parent=$(ps -p "$target" -o ppid= | tr -d ' ')
  [ "$current_parent" = "$parent" ] || continue
  failure=$(kill -TERM "$target" 2>&1) || {{ [ -z "$(ps -p "$target" -o pid=)" ] || {{ printf 'monitor.killFailed: %s\n' "$failure"; exit 1; }}; }}
done
"#
    )
}

// Materialize the process handle before checking StartTime. .Kill() operates on
// that process object rather than looking up a potentially reused PID again.
fn win_guard(pid: u32, start: Option<u64>) -> String {
    let check = start.map(|start| format!("if (([DateTimeOffset]$target.StartTime).ToUnixTimeMilliseconds() -ne {start}) {{ throw 'monitor.processChanged' }};")).unwrap_or_default();
    format!("$target = Get-Process -Id {pid} -ErrorAction SilentlyContinue; if ($null -eq $target) {{ throw 'monitor.processChanged' }}; $null = $target.Handle; {check}")
}

fn win_script(body: &str, error: &str) -> String {
    powershell(&format!("$ErrorActionPreference='Stop'; [Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false); try {{ {body} }} catch {{ if ($_.Exception.Message -like 'monitor.*') {{ [Console]::Write($_.Exception.Message) }} else {{ [Console]::Write('{error}: '+$_.Exception.Message) }}; exit 1 }}"))
}

pub(super) fn win_kill(pid: u32, start: Option<u64>) -> String {
    win_script(
        &format!(
            "{} $target.Kill(); [Console]::Write('TUNNELDE_OK')",
            win_guard(pid, start)
        ),
        "monitor.killFailed",
    )
}

pub(super) fn win_tree(pid: u32, start: u64) -> String {
    let guard = win_guard(pid, Some(start));
    let ongoing = format!("try {{ {guard} }} catch {{ if ($null -eq $target -or $target.HasExited) {{ break }}; throw }}");
    win_script(
        &format!(
            r#"
{guard}
$rows = @{{}}; Get-CimInstance Win32_Process | ForEach-Object {{ $rows[[uint32]$_.ProcessId] = $_ }}
$depth = @{{}}; $depth[[uint32]{pid}] = 1
for ($pass=0; $pass -lt $rows.Count; $pass++) {{
    $changed=$false
    foreach ($id in @($rows.Keys)) {{
        $parent=[uint32]$rows[$id].ParentProcessId
        if (-not $depth.ContainsKey($id) -and $depth.ContainsKey($parent)) {{ $depth[$id]=$depth[$parent]+1; $changed=$true }}
    }}
    if (-not $changed) {{ break }}
}}
$current=[uint32]$PID; $seen=@{{}}
while ($current -gt 1 -and -not $seen.ContainsKey($current)) {{
    if ($depth.ContainsKey($current)) {{ throw 'monitor.killProtected' }}
    $seen[$current]=$true
    if (-not $rows.ContainsKey($current)) {{ break }}
    $current=[uint32]$rows[$current].ParentProcessId
}}
foreach ($id in @($depth.Keys | Sort-Object -Property {{ $depth[$_] }} -Descending)) {{
    {ongoing}
    $row=$rows[$id]; if ($null -eq $row -or $null -eq $row.CreationDate) {{ continue }}
    $child=Get-Process -Id $id -ErrorAction SilentlyContinue
    if ($null -eq $child) {{ continue }}
    try {{
    $null=$child.Handle
    if ($child.HasExited) {{ continue }}
    if (([DateTimeOffset]$child.StartTime).ToUnixTimeMilliseconds() -ne ([DateTimeOffset]$row.CreationDate).ToUnixTimeMilliseconds()) {{ continue }}
    $currentRow=Get-CimInstance Win32_Process -Filter "ProcessId=$id"
    if ($null -eq $currentRow -or $currentRow.ParentProcessId -ne $row.ParentProcessId) {{ continue }}
    $child.Kill()
    }} catch {{
        # A child may exit between enumeration, opening its handle and termination.
        # HasExited refers to the same process object, so PID reuse is not accepted.
        if ($child.HasExited) {{ continue }}
        throw ('monitor.killFailed: '+$id+': '+$_.Exception.Message)
    }}
}}
[Console]::Write('TUNNELDE_OK')
"#
        ),
        "monitor.killFailed",
    )
}

pub(super) fn win_executable(pid: u32, start: u64) -> String {
    win_script(&format!("{} $path=$target.MainModule.FileName; if ([string]::IsNullOrWhiteSpace($path)) {{ throw 'monitor.executableUnavailable' }}; {} [Console]::Write($path)", win_guard(pid, Some(start)), win_guard(pid, Some(start))), "monitor.executableUnavailable")
}

pub(super) fn win_launch(command: &str, cwd: &str) -> AppResult<String> {
    let cwd = cwd
        .strip_prefix('/')
        .filter(|p| p.as_bytes().get(1) == Some(&b':'))
        .unwrap_or(cwd);
    let drive = cwd.as_bytes();
    let absolute = drive.len() >= 3
        && drive[0].is_ascii_alphabetic()
        && drive[1] == b':'
        && matches!(drive[2], b'/' | b'\\');
    let unc =
        cwd.starts_with("\\\\") && cwd[2..].split('\\').filter(|s| !s.is_empty()).count() >= 2;
    if !cwd.is_empty() && !absolute && !unc {
        return Err(AppError::validation("monitor.invalidTask"));
    }
    // CIM Create starts a detached process without inheriting the SSH channel.
    let child = powershell(&format!("& {{ {command}\n }} *> $null"));
    let directory = if cwd.is_empty() {
        "$null".to_owned()
    } else {
        ps_literal(cwd)
    };
    let script = win_script(&format!("$r=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{{ CommandLine={}; CurrentDirectory={} }}; if ($r.ReturnValue -ne 0 -or $r.ProcessId -le 1) {{ throw 'monitor.launchFailed' }}; [Console]::Write('TUNNELDE_PID='+$r.ProcessId)", ps_literal(&child), directory), "monitor.launchFailed");
    // EncodedCommand is passed through the Windows default SSH shell (cmd has an 8191 character limit).
    if script.len() > 8000 {
        return Err(AppError::validation("monitor.invalidTask"));
    }
    Ok(script)
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;

    fn decoded(command: &str) -> String {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(command.split_whitespace().last().unwrap())
            .unwrap();
        String::from_utf16(
            &bytes
                .chunks_exact(2)
                .map(|b| u16::from_le_bytes([b[0], b[1]]))
                .collect::<Vec<_>>(),
        )
        .unwrap()
    }

    #[test]
    fn windows_commands_fit_default_cmd_shell_and_guard_process_handles() {
        for command in [
            super::super::super::processes::platform::Platform::Windows.script(false),
            win_kill(42, Some(1795831323000)),
            win_tree(42, 1795831323000),
            win_executable(42, 1795831323000),
            win_launch("Write-Output '中文'", "C:\\Program Files\\Example App").unwrap(),
        ] {
            assert!(command.len() < 8000, "command length: {}", command.len());
            assert!(!command.contains(['\n', '\r', '\'', '"', '$']));
        }
        let script = decoded(&win_kill(42, Some(123)));
        assert!(script.find("$target.Handle").unwrap() < script.find("$target.StartTime").unwrap());
        assert!(script.find("$target.StartTime").unwrap() < script.find("$target.Kill()").unwrap());
        let script = decoded(&win_tree(42, 123));
        assert!(script.contains("monitor.killProtected"));
        assert!(script.contains("$currentRow.ParentProcessId -ne $row.ParentProcessId"));
    }

    #[test]
    fn windows_launch_accepts_native_and_sftp_paths_and_quotes_literals() {
        for path in [
            "",
            "C:\\",
            "C:/with spaces/a'$(x)",
            "/C:/Temp",
            "\\\\server\\share\\dir",
        ] {
            assert!(win_launch("Write-Output 'ok'", path).is_ok(), "{path}");
        }
        for path in ["relative", "C:relative", "/tmp", "\\\\server"] {
            assert!(win_launch("echo hi", path).is_err(), "{path}");
        }
        let script = decoded(&win_launch("Write-Output '中文'", "C:/a'$(Get-Process)").unwrap());
        assert!(script.contains("CurrentDirectory='C:/a''$(Get-Process)'"));
        assert!(script.contains("Invoke-CimMethod -ClassName Win32_Process -MethodName Create"));
        assert!(win_launch(&"x".repeat(16000), "C:/").is_err());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_guards_real_tree_and_rejects_changed_identity() {
        use std::io::{BufRead, BufReader};
        use std::process::{Command, Stdio};
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
        let output = Command::new("sh")
            .args(["-c", &format!("id={pid}; {MAC_START}")])
            .output()
            .unwrap();
        let start: u64 = String::from_utf8(output.stdout)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        let refused = Command::new("sh")
            .args(["-c", &mac_tree(pid, start + 1)])
            .output()
            .unwrap();
        assert!(String::from_utf8_lossy(&refused.stdout).contains("monitor.processChanged"));
        assert!(root.try_wait().unwrap().is_none());
        let result = Command::new("sh")
            .args(["-c", &mac_tree(pid, start)])
            .output()
            .unwrap();
        let _ = root.kill();
        let _ = root.wait();
        let alive = Command::new("ps")
            .args(["-p", &child.to_string(), "-o", "stat="])
            .output()
            .unwrap();
        let _ = Command::new("kill")
            .args(["-KILL", &child.to_string()])
            .output();
        assert!(result.stdout.is_empty(), "{result:?}");
        assert!(
            alive.stdout.is_empty() || alive.stdout.starts_with(b"Z"),
            "{alive:?}"
        );
    }
}

#[cfg(all(test, target_os = "windows"))]
mod windows_tests {
    use super::*;
    use std::process::Command;

    fn run(command: &str) -> String {
        let args: Vec<_> = command.split_whitespace().collect();
        let output = Command::new(args[0]).args(&args[1..]).output().unwrap();
        String::from_utf8(output.stdout).unwrap()
    }

    #[test]
    fn windows_launch_and_identity_checked_tree_termination() {
        let output = run(&win_launch("Start-Process -FilePath $env:ComSpec -ArgumentList '/d /c ping -n 30 127.0.0.1 >nul'; Start-Sleep -Seconds 30", "").unwrap());
        let pid: u32 = output
            .strip_prefix("TUNNELDE_PID=")
            .expect(&output)
            .parse()
            .unwrap();
        let start: u64 = run(&powershell(&format!("[Console]::Write(([DateTimeOffset](Get-Process -Id {pid}).StartTime).ToUnixTimeMilliseconds())"))).trim().parse().unwrap();
        let refused = run(&win_kill(pid, Some(start + 1)));
        assert_eq!(refused, "monitor.processChanged");
        let children = run(&powershell(&format!("[Console]::Write((@(Get-CimInstance Win32_Process -Filter 'ParentProcessId={pid}' | Select-Object -ExpandProperty ProcessId) -join ','))")));
        let result = run(&win_tree(pid, start));
        // Always attempt cleanup of test-owned processes, including on a failing assertion.
        let _ = run(&win_kill(pid, Some(start)));
        assert_eq!(result, "TUNNELDE_OK");
        assert!(
            !children.trim().is_empty(),
            "test task did not create its child"
        );
        for child in children.trim().split(',') {
            let alive = run(&powershell(&format!("if (Get-Process -Id {child} -ErrorAction SilentlyContinue) {{ [Console]::Write('alive') }}")));
            assert!(alive.is_empty(), "child {child} survived tree termination");
        }
    }

    #[test]
    fn windows_tree_ignores_exits_while_opening_handles_and_terminating() {
        use base64::Engine;
        let command = win_tree(42, 1795831323000);
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(command.split_whitespace().last().unwrap())
            .unwrap();
        let body = String::from_utf16(
            &bytes
                .chunks_exact(2)
                .map(|b| u16::from_le_bytes([b[0], b[1]]))
                .collect::<Vec<_>>(),
        )
        .unwrap();
        for mode in ["handle", "kill"] {
            // Deterministic exits at the two race boundaries in the production script.
            let mock = format!(
                r#"
$script:mode='{mode}'
$stamp=[DateTimeOffset]::FromUnixTimeMilliseconds(1795831323000).LocalDateTime
$script:root=[pscustomobject]@{{Handle=1;StartTime=$stamp;HasExited=$false}}
$script:root | Add-Member -MemberType ScriptMethod -Name Kill -Value {{}}
$script:child=[pscustomobject]@{{StartTime=$stamp;HasExited=$false}}
$script:child | Add-Member -MemberType ScriptProperty -Name Handle -Value {{
    if ($script:mode -eq 'handle') {{ $this.HasExited=$true; throw 'process exited during handle acquisition' }}
    1
}}
$script:child | Add-Member -MemberType ScriptMethod -Name Kill -Value {{
    $this.HasExited=$true; throw 'process exited during termination'
}}
$script:rootRow=[pscustomobject]@{{ProcessId=[uint32]42;ParentProcessId=[uint32]1;CreationDate=$stamp}}
$script:childRow=[pscustomobject]@{{ProcessId=[uint32]43;ParentProcessId=[uint32]42;CreationDate=$stamp}}
function Get-Process {{
    param($Id,$ErrorAction)
    if ($Id -eq 42) {{ return $script:root }}
    if ($Id -eq 43) {{ return $script:child }}
}}
function Get-CimInstance {{
    param($ClassName,$Filter)
    if ($Filter -eq 'ProcessId=42') {{ return $script:rootRow }}
    if ($Filter -eq 'ProcessId=43') {{ return $script:childRow }}
    @($script:rootRow,$script:childRow)
}}
"#
            );
            assert_eq!(
                run(&powershell(&format!("{mock}\n{body}"))),
                "TUNNELDE_OK",
                "{mode}"
            );
        }
    }
}
