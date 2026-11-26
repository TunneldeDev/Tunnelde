//! Identity-checked remote process actions. No local filesystem paths are used.
use super::exec;
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
for(id in d) print d[id],id,p[id],start[id]}}' | sort -rn)
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

pub async fn kill_tree(app: &AppHandle, session: &str, pid: u32, start: u64) -> AppResult<()> {
    let output = exec(app, session, &tree_script(pid, start)?).await?;
    if output.trim().is_empty() {
        Ok(())
    } else {
        Err(AppError::Ssh(output.trim().to_owned()))
    }
}

pub async fn executable(app: &AppHandle, session: &str, pid: u32, start: u64) -> AppResult<String> {
    let check = guard(pid, start)?;
    let output = exec(app, session, &format!("{check}path=$(readlink /proc/{pid}/exe 2>/dev/null) || {{ echo monitor.executableUnavailable; exit 1; }}; {check}printf '%s' \"$path\"")).await?;
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

