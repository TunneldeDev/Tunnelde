use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use super::monitor::RemoteProcess;
use crate::error::{AppError, AppResult};

// Read-only Linux sampling. ps supplies identity; /proc supplies interval counters.
// A disappearing or inaccessible process is skipped by getline without aborting the scan.
pub(super) const BASE_SCRIPT: &str = r##"
export LC_ALL=C
echo '#processes'
ps -eo pid=,uid=,gid=,user:64=,group:64=,ppid=,nlwp=,stat=,rss=,comm= 2>/dev/null
awk 'BEGIN {
  while ((getline line < "/proc/stat") > 0) {
    if (line ~ /^cpu /) { split(line, a); for (j=2;j<=9;j++) total+=a[j] }
    else if (line ~ /^cpu[0-9]/) cores++
  }
  close("/proc/stat"); getline uptime < "/proc/uptime"; close("/proc/uptime"); split(uptime,u)
  while ((getline line < "/proc/meminfo") > 0) { if (line ~ /^MemTotal:/) { split(line,m); memory=m[2]*1024; break } }
  close("/proc/meminfo")
  printf "#process-meta\n%.0f %d %s %.0f\n#process-ticks\n",total,cores,u[1],memory
  for (i=1;i<ARGC;i++) {
    if ((getline line < ARGV[i]) > 0) {
      path=ARGV[i]; sub(/\/stat$/, "", path); pid=path; sub(/^.*\//, "", pid)
      sub(/^.*\) /, "", line); split(line,a)
      read=-1; write=-1
      while ((getline io < (path "/io")) > 0) {
        split(io,b); if (b[1]=="read_bytes:") read=b[2]; else if (b[1]=="write_bytes:") write=b[2]
      }
      close(path "/io")
      if (a[20] ~ /^[0-9]+$/) printf "%s %s %.0f %.0f %.0f\n",pid,a[20],a[12]+a[13],read,write
    }
    close(ARGV[i])
  }
}' /proc/[0-9]*/stat
"##;

pub(super) const OPTIONAL_SCRIPT: &str = r##"
echo '#process-network'
if command -v ss >/dev/null 2>&1; then ss -H -t -i -n -p -e 2>/dev/null; fi
echo '#process-gpu-drm'
if [ -d /sys/class/drm ]; then
  find /proc/[0-9]*/fd -maxdepth 1 -lname '/dev/dri/*' -print 2>/dev/null | awk '
  {
    path=$0; sub(/\/fd\//,"/fdinfo/",path); pid=path; sub(/^\/proc\//,"",pid); sub(/\/.*$/,"",pid)
    client=""; device=""; memory=-1; resident=-1; delete engines
    while ((getline line < path)>0) {
      split(line,a)
      if (a[1]=="drm-client-id:") client=a[2]
      else if (a[1]=="drm-pdev:") device=a[2]
      else if ((a[1]=="drm-memory-vram:" || a[1]=="drm-total-vram:") && a[3]=="KiB") memory=a[2]*1024
      else if (a[1]=="drm-resident-vram:" && a[3]=="KiB") resident=a[2]*1024
      else if (a[1] ~ /^drm-engine-/ && a[3]=="ns") engines[a[1]]=a[2]
    }
    close(path)
    if (client!="" && device!="") {
      if (resident>=0) memory=resident
      if (memory>=0) printf "%s %s %s memory %.0f\n",pid,device,client,memory
      for (engine in engines) printf "%s %s %s %s %.0f\n",pid,device,client,engine,engines[engine]
    }
  }'
fi
echo '#process-gpu-memory'
if command -v nvidia-smi >/dev/null 2>&1; then
  nvidia-smi --query-compute-apps=pid,gpu_uuid,used_gpu_memory --format=csv,noheader,nounits 2>/dev/null
  echo '#process-gpu'
  nvidia-smi pmon -c 1 -s u 2>/dev/null
fi
true
"##;

#[derive(Clone, Default)]
struct Counter {
    start: u64,
    cpu: u64,
    read: Option<u64>,
    written: Option<u64>,
}

#[derive(Clone, Default)]
struct Socket {
    owners: Vec<u32>,
    rx: Option<u64>,
    tx: Option<u64>,
}

#[derive(Default)]
struct Sample {
    cpu: u64,
    cores: u32,
    uptime: f64,
    memory: u64,
    network_at: Option<f64>,
    gpu_at: Option<f64>,
    optional_starts: HashMap<u32, u64>,
    observed_at: Option<Instant>,
    counters: HashMap<u32, Counter>,
    sockets: HashMap<u64, Socket>,
    gpu_engines: HashMap<(u32, String, String, String), u64>,
    items: Vec<RemoteProcess>,
}

#[derive(Default)]
pub(super) struct ProcessCache(Mutex<HashMap<String, Sample>>);

impl ProcessCache {
    pub(super) fn forget(&self, session: &str) {
        if let Ok(mut samples) = self.0.lock() {
            samples.remove(session);
        }
    }

    pub(super) fn ready(&self, session: &str) -> bool {
        self.0.lock().is_ok_and(|samples| {
            samples
                .get(session)
                .and_then(|sample| sample.observed_at)
                .is_some_and(|at| at.elapsed() < Duration::from_secs(15))
        })
    }

    pub(super) fn update(
        &self,
        session: &str,
        raw: &str,
        optional: bool,
    ) -> AppResult<Vec<RemoteProcess>> {
        let mut next = parse(raw)?;
        let mut samples = self
            .0
            .lock()
            .map_err(|_| AppError::internal("monitor.lock"))?;
        let previous = samples.get(session);
        calculate(&mut next, previous, optional);
        // Overview samples do not query optional GPU or socket telemetry. Preserve its baseline
        // separately rather than interpreting a missing collector as a zero counter.
        if !optional {
            if let Some(previous) = previous {
                next.sockets = previous.sockets.clone();
                next.network_at = previous.network_at;
                next.gpu_at = previous.gpu_at;
                next.gpu_engines = previous.gpu_engines.clone();
                next.optional_starts = previous.optional_starts.clone();
            }
        } else {
            next.network_at = Some(next.uptime);
            next.gpu_at = Some(next.uptime);
            next.optional_starts = next
                .counters
                .iter()
                .map(|(pid, counter)| (*pid, counter.start))
                .collect();
        }
        let result = next.items.clone();
        samples.insert(session.to_owned(), next);
        Ok(result)
    }
}

fn finite(value: &str) -> Option<f32> {
    value
        .parse::<f32>()
        .ok()
        .filter(|value| value.is_finite() && *value >= 0.0)
}

fn number_after(line: &str, key: &str) -> Option<u64> {
    line.split_whitespace()
        .find_map(|part| part.strip_prefix(key)?.parse().ok())
}

fn parse(raw: &str) -> AppResult<Sample> {
    let mut sample = Sample {
        observed_at: Some(Instant::now()),
        ..Sample::default()
    };
    let mut section = "";
    let mut socket = None;
    let mut gpu_columns: Vec<&str> = Vec::new();
    let mut seen_gpu = HashSet::new();
    let mut gpu_memory = HashMap::<u32, u64>::new();
    let mut gpu_percent = HashMap::<u32, f32>::new();
    let mut drm_memory = HashMap::<(u32, String, String), u64>::new();
    for line in raw.lines() {
        if let Some(next) = line.strip_prefix('#') {
            if next.trim().starts_with("process-") || next.trim() == "processes" {
                section = next.trim();
                socket = None;
                continue;
            }
            if section == "process-gpu" {
                let fields: Vec<_> = next.split_whitespace().collect();
                if fields.contains(&"pid") && fields.contains(&"sm") {
                    gpu_columns = fields;
                }
            }
            continue;
        }
        let fields: Vec<_> = line.split_whitespace().collect();
        match section {
            "processes" if fields.len() >= 10 => {
                let Some(pid) = fields[0].parse::<u32>().ok() else {
                    continue;
                };
                let rss = fields[8].parse::<u64>().unwrap_or(0).saturating_mul(1024);
                sample.items.push(RemoteProcess {
                    pid,
                    name: fields[9..].join(" "),
                    rss,
                    uid: fields[1].parse().ok(),
                    gid: fields[2].parse().ok(),
                    user_name: Some(fields[3].to_owned()),
                    group_name: Some(fields[4].to_owned()),
                    parent_pid: fields[5].parse().ok(),
                    threads: fields[6].parse().ok(),
                    state: Some(fields[7].to_owned()),
                    ..RemoteProcess::default()
                });
            }
            "process-meta" if fields.len() == 4 => {
                sample.cpu = fields[0].parse().unwrap_or(0);
                sample.cores = fields[1].parse().unwrap_or(0);
                sample.uptime = fields[2]
                    .parse::<f64>()
                    .ok()
                    .filter(|value| value.is_finite())
                    .unwrap_or(0.0);
                sample.memory = fields[3].parse().unwrap_or(0);
            }
            "process-ticks" if fields.len() == 5 => {
                if let (Ok(pid), Ok(start), Ok(cpu)) =
                    (fields[0].parse(), fields[1].parse(), fields[2].parse())
                {
                    sample.counters.insert(
                        pid,
                        Counter {
                            start,
                            cpu,
                            read: fields[3].parse().ok(),
                            written: fields[4].parse().ok(),
                        },
                    );
                }
            }
            "process-network" => {
                if !line.starts_with(char::is_whitespace) {
                    socket = number_after(line, "ino:");
                    if let Some(inode) = socket {
                        let owners = line
                            .split("pid=")
                            .skip(1)
                            .filter_map(|part| {
                                part.split(|ch: char| !ch.is_ascii_digit())
                                    .next()?
                                    .parse()
                                    .ok()
                            })
                            .collect();
                        sample.sockets.insert(
                            inode,
                            Socket {
                                owners,
                                ..Socket::default()
                            },
                        );
                    }
                } else if let Some(entry) = socket.and_then(|inode| sample.sockets.get_mut(&inode))
                {
                    entry.rx = number_after(line, "bytes_received:").or(entry.rx);
                    entry.tx = number_after(line, "bytes_sent:")
                        .or_else(|| number_after(line, "bytes_acked:"))
                        .or(entry.tx);
                }
            }
            "process-gpu-memory" => {
                let fields: Vec<_> = line.split(',').map(str::trim).collect();
                if fields.len() == 3 {
                    if let (Ok(pid), Some(memory)) = (fields[0].parse::<u32>(), finite(fields[2])) {
                        if seen_gpu.insert((pid, fields[1].to_owned())) {
                            let entry = gpu_memory.entry(pid).or_default();
                            *entry =
                                entry.saturating_add((f64::from(memory) * 1024.0 * 1024.0) as u64);
                        }
                    }
                }
            }
            "process-gpu-drm" if fields.len() == 5 => {
                if let (Ok(pid), Ok(value)) = (fields[0].parse::<u32>(), fields[4].parse::<u64>()) {
                    if fields[3] == "memory" {
                        drm_memory
                            .entry((pid, fields[1].to_owned(), fields[2].to_owned()))
                            .and_modify(|old| *old = (*old).max(value))
                            .or_insert(value);
                    } else if fields[3].starts_with("drm-engine-") {
                        sample
                            .gpu_engines
                            .entry((
                                pid,
                                fields[1].to_owned(),
                                fields[2].to_owned(),
                                fields[3].to_owned(),
                            ))
                            .and_modify(|old| *old = (*old).max(value))
                            .or_insert(value);
                    }
                }
            }
            "process-gpu" if !gpu_columns.is_empty() => {
                let get = |name| {
                    gpu_columns
                        .iter()
                        .position(|column| *column == name)
                        .and_then(|index| fields.get(index).copied())
                };
                if let Some(pid) = get("pid").and_then(|pid| pid.parse::<u32>().ok()) {
                    // Show the busiest reported engine, rather than summing unrelated engines.
                    for value in ["sm", "enc", "dec", "jpg", "ofa"]
                        .into_iter()
                        .filter_map(|name| get(name).and_then(finite))
                    {
                        gpu_percent
                            .entry(pid)
                            .and_modify(|old| *old = old.max(value.min(100.0)))
                            .or_insert(value.min(100.0));
                    }
                }
            }
            _ => {}
        }
    }
    if sample.cpu == 0
        || sample.cores == 0
        || sample.uptime <= 0.0
        || sample.items.is_empty()
        || sample.items.len() > 20_000
    {
        return Err(AppError::Ssh("monitor.processUnsupported".into()));
    }
    let mut drm_totals = HashMap::<u32, u64>::new();
    for ((pid, _, _), memory) in drm_memory {
        let total = drm_totals.entry(pid).or_default();
        *total = total.saturating_add(memory);
    }
    for process in &mut sample.items {
        process.memory = if sample.memory > 0 {
            (process.rss as f64 / sample.memory as f64 * 100.0).clamp(0.0, 100.0) as f32
        } else {
            0.0
        };
        process.gpu_memory = gpu_memory
            .get(&process.pid)
            .or_else(|| drm_totals.get(&process.pid))
            .copied();
        process.gpu_percent = gpu_percent.get(&process.pid).copied();
    }
    Ok(sample)
}

fn rate(current: Option<u64>, previous: Option<u64>, seconds: f64) -> Option<f32> {
    let delta = current?.checked_sub(previous?)?;
    let result = (delta as f64 / seconds) as f32;
    result.is_finite().then_some(result)
}

fn calculate(next: &mut Sample, previous: Option<&Sample>, optional: bool) {
    let baseline = previous.filter(|old| {
        next.uptime > old.uptime
            && next.uptime - old.uptime <= 30.0
            && next.cpu > old.cpu
            && next.cores == old.cores
    });
    let mut sockets_by_pid = HashMap::<u32, Vec<_>>::new();
    for (inode, socket) in &next.sockets {
        let mut seen = HashSet::new();
        for pid in &socket.owners {
            if seen.insert(pid) {
                sockets_by_pid
                    .entry(*pid)
                    .or_default()
                    .push((inode, socket));
            }
        }
    }
    let mut engines_by_pid = HashMap::<u32, Vec<_>>::new();
    for (key, value) in &next.gpu_engines {
        engines_by_pid.entry(key.0).or_default().push((key, value));
    }
    for process in &mut next.items {
        let Some(counter) = next.counters.get(&process.pid) else {
            continue;
        };
        process.started_at_ticks = Some(counter.start);
        let Some(previous) = baseline else { continue };
        let Some(old) = previous
            .counters
            .get(&process.pid)
            .filter(|old| old.start == counter.start && counter.cpu >= old.cpu)
        else {
            continue;
        };
        let seconds = next.uptime - previous.uptime;
        let cpu = ((counter.cpu - old.cpu) as f64 / (next.cpu - previous.cpu) as f64 * 100.0)
            .clamp(0.0, 100.0) as f32;
        process.cpu_total = Some(cpu);
        process.cpu = cpu * next.cores as f32;
        process.disk_read_rate = rate(counter.read, old.read, seconds);
        process.disk_write_rate = rate(counter.written, old.written, seconds);
        if !optional {
            continue;
        }
        if previous.optional_starts.get(&process.pid) != Some(&counter.start) {
            continue;
        }
        if let Some(gpu_at) = previous
            .gpu_at
            .filter(|at| next.uptime > *at && next.uptime - *at <= 30.0)
        {
            let mut engines = HashMap::<(&str, &str), u64>::new();
            for &(key @ (_, device, _, engine), now) in
                engines_by_pid.get(&process.pid).into_iter().flatten()
            {
                if let Some(delta) = previous
                    .gpu_engines
                    .get(key)
                    .and_then(|before| now.checked_sub(*before))
                {
                    let total = engines
                        .entry((device.as_str(), engine.as_str()))
                        .or_default();
                    *total = total.saturating_add(delta);
                }
            }
            for time in engines.values() {
                let load = (*time as f64 / ((next.uptime - gpu_at) * 1_000_000_000.0) * 100.0)
                    .clamp(0.0, 100.0) as f32;
                process.gpu_percent = Some(process.gpu_percent.unwrap_or(0.0).max(load));
            }
        }
        let Some(network_at) = previous
            .network_at
            .filter(|at| next.uptime > *at && next.uptime - *at <= 30.0)
        else {
            continue;
        };
        let seconds = next.uptime - network_at;
        for &(inode, socket) in sockets_by_pid.get(&process.pid).into_iter().flatten() {
            let Some(before) = previous
                .sockets
                .get(inode)
                .filter(|before| before.owners.contains(&process.pid))
            else {
                continue;
            };
            if let Some(rx) = rate(socket.rx, before.rx, seconds) {
                *process.network_rx_rate.get_or_insert(0.0) += rx;
            }
            if let Some(tx) = rate(socket.tx, before.tx, seconds) {
                *process.network_tx_rate.get_or_insert(0.0) += tx;
            }
        }
    }
    next.items.sort_by(|a, b| {
        b.cpu_total
            .unwrap_or(-1.0)
            .total_cmp(&a.cpu_total.unwrap_or(-1.0))
            .then_with(|| a.pid.cmp(&b.pid))
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw(uptime: f64, cpu: u64, ticks: u64, start: u64, io: &str) -> String {
        format!("#processes\n42 1000 100 users developers 1 4 Sl 1024 worker with spaces\n#process-meta\n{cpu} 8 {uptime} 8388608\n#process-ticks\n42 {start} {ticks} {io}\n")
    }

    fn socket(rx: u64, tx: u64) -> String {
        format!("#process-network\nESTAB 0 0 local:1 remote:2 users:((\"worker\",pid=42,fd=3),(\"worker\",pid=42,fd=4)) ino:99\n\t bytes_received:{rx} bytes_sent:{tx}\n")
    }

    #[test]
    fn recent_cpu_uses_machine_capacity_and_keeps_per_core_compatibility() {
        let cache = ProcessCache::default();
        let first = cache
            .update("s", &raw(10.0, 1000, 100, 5, "1000 2000"), false)
            .unwrap();
        assert_eq!(first[0].cpu_total, None);
        let result = cache
            .update("s", &raw(11.0, 1800, 391, 5, "2024 4048"), false)
            .unwrap();
        let p = &result[0];
        assert!((p.cpu_total.unwrap() - 36.375).abs() < 0.001);
        assert!((p.cpu - 291.0).abs() < 0.001);
        assert_eq!(p.disk_read_rate, Some(1024.0));
        assert_eq!(p.disk_write_rate, Some(2048.0));
        assert_eq!(p.name, "worker with spaces");
        assert_eq!(p.memory, 12.5);
        assert_eq!(p.user_name.as_deref(), Some("users"));
        assert_eq!(p.group_name.as_deref(), Some("developers"));
        assert_eq!(p.uid, Some(1000));
        assert_eq!(p.gid, Some(100));
        assert_eq!(p.parent_pid, Some(1));
        assert_eq!(p.threads, Some(4));
    }

    #[test]
    fn denied_io_and_reset_counters_remain_unknown() {
        let cache = ProcessCache::default();
        cache
            .update("s", &raw(10.0, 1000, 100, 5, "1000 -1"), false)
            .unwrap();
        let p = cache
            .update("s", &raw(11.0, 1800, 110, 5, "500 -1"), false)
            .unwrap()
            .remove(0);
        assert_eq!(p.disk_read_rate, None);
        assert_eq!(p.disk_write_rate, None);
        assert_eq!(p.gpu_percent, None);
        assert_eq!(p.gpu_memory, None);
        assert_eq!(p.network_rx_rate, None);
    }

    #[test]
    fn pid_reuse_and_stale_samples_do_not_spike() {
        let cache = ProcessCache::default();
        cache
            .update("s", &raw(10.0, 1000, 100, 5, "1000 1000"), false)
            .unwrap();
        let reused = cache
            .update("s", &raw(11.0, 1800, 900, 9, "99999 99999"), false)
            .unwrap();
        assert_eq!(reused[0].cpu_total, None);
        assert_eq!(reused[0].started_at_ticks, Some(9));
        let stale = cache
            .update("s", &raw(9.0, 500, 100, 9, "99999 99999"), false)
            .unwrap();
        assert_eq!(stale[0].cpu_total, None);
        let old = cache
            .update("s", &raw(100.0, 9999, 999, 9, "99999 99999"), false)
            .unwrap();
        assert_eq!(old[0].cpu_total, None);
        cache.forget("s");
        assert!(!cache.ready("s"));
    }

    #[test]
    fn tcp_baseline_survives_overview_without_shortening_interval_or_counting_duplicate_owners() {
        let cache = ProcessCache::default();
        cache
            .update(
                "s",
                &(raw(10.0, 1000, 100, 5, "0 0") + &socket(1000, 2000)),
                true,
            )
            .unwrap();
        cache
            .update("s", &raw(11.0, 1800, 200, 5, "0 0"), false)
            .unwrap();
        let p = cache
            .update(
                "s",
                &(raw(12.0, 2600, 300, 5, "0 0") + &socket(1400, 2600)),
                true,
            )
            .unwrap()
            .remove(0);
        assert_eq!(p.network_rx_rate, Some(200.0));
        assert_eq!(p.network_tx_rate, Some(300.0));
    }

    #[test]
    fn tcp_reuse_resets_and_long_intervals_are_unknown() {
        let cache = ProcessCache::default();
        cache
            .update(
                "s",
                &(raw(10.0, 1000, 100, 5, "0 0") + &socket(1000, 2000)),
                true,
            )
            .unwrap();
        cache
            .update("s", &raw(11.0, 1800, 100, 6, "0 0"), false)
            .unwrap();
        let p = cache
            .update(
                "s",
                &(raw(12.0, 2600, 200, 6, "0 0") + &socket(5000, 9000)),
                true,
            )
            .unwrap()
            .remove(0);
        assert_eq!(p.network_rx_rate, None);
        let p = cache
            .update("s", &(raw(13.0, 3400, 300, 6, "0 0") + &socket(5, 9)), true)
            .unwrap()
            .remove(0);
        assert_eq!(p.network_rx_rate, None);
        cache
            .update("s", &raw(49.0, 4000, 400, 6, "0 0"), false)
            .unwrap();
        let p = cache
            .update(
                "s",
                &(raw(50.0, 4800, 500, 6, "0 0") + &socket(999, 999)),
                true,
            )
            .unwrap()
            .remove(0);
        assert_eq!(p.network_rx_rate, None);
    }

    #[test]
    fn drm_deduplicates_file_descriptors_and_uses_separate_engine_interval() {
        let cache = ProcessCache::default();
        let gpu = |engine| {
            format!("#process-gpu-drm\n42 dev 7 memory 2048\n42 dev 7 memory 2048\n42 dev 7 drm-engine-render: {engine}\n42 dev 7 drm-engine-render: {engine}\n")
        };
        cache
            .update(
                "s",
                &(raw(10.0, 1000, 100, 5, "0 0") + &gpu(1_000_000_000_u64)),
                true,
            )
            .unwrap();
        cache
            .update("s", &raw(11.0, 1800, 200, 5, "0 0"), false)
            .unwrap();
        let p = cache
            .update(
                "s",
                &(raw(12.0, 2600, 300, 5, "0 0") + &gpu(2_000_000_000_u64)),
                true,
            )
            .unwrap()
            .remove(0);
        assert_eq!(p.gpu_memory, Some(2048));
        assert_eq!(p.gpu_percent, Some(50.0));
    }

    #[test]
    fn nvidia_reads_column_headers_and_deduplicates_memory_per_device() {
        let raw = raw(10.0, 1000, 100, 5, "0 0") + "#process-gpu-memory\n42, GPU-a, 100\n42, GPU-a, 100\n42, GPU-b, 50\n#process-gpu\n# gpu pid type sm mem enc dec command\n0 42 C 70 8 10 - worker\n1 42 C 25 4 90 - worker\n";
        let p = ProcessCache::default()
            .update("s", &raw, true)
            .unwrap()
            .remove(0);
        assert_eq!(p.gpu_memory, Some(150 * 1024 * 1024));
        assert_eq!(p.gpu_percent, Some(90.0));
    }

    #[test]
    fn rejects_unsupported_and_nonfinite_samples() {
        assert!(parse("#processes\n").is_err());
        assert!(parse(&raw(f64::NAN, 1000, 100, 5, "0 0")).is_err());
        assert!(parse(&raw(10.0, 1000, 100, 5, "0 0").replace("42 1000", "bad 1000")).is_err());
    }

    #[test]
    #[ignore = "requires read-only captures in TUNNELDE_PROCESS_FIXTURE_DIR"]
    fn captured_linux_samples_parse_with_real_permissions() {
        let dir = std::env::var("TUNNELDE_PROCESS_FIXTURE_DIR").expect("capture directory");
        let cache = ProcessCache::default();
        for n in 0..2 {
            let raw = std::fs::read_to_string(format!("{dir}/sample-{n}.txt")).unwrap();
            let items = cache.update("live", &raw, true).unwrap();
            assert!(items.len() > 10);
            assert!(items
                .iter()
                .all(|p| p.pid > 0 && p.uid.is_some() && p.group_name.is_some()));
            if n == 1 {
                assert!(items.iter().any(|p| p.cpu_total.is_some()));
                assert!(items.iter().any(|p| p.disk_read_rate.is_some()));
                assert!(items.iter().any(|p| p.network_rx_rate.is_some()));
                assert!(items.iter().all(|p| p
                    .cpu_total
                    .is_none_or(|cpu| cpu.is_finite() && (0.0..=100.0).contains(&cpu))));
                println!(
                    "{} processes, {} IO-readable, {} TCP-readable, {} GPU-readable",
                    items.len(),
                    items.iter().filter(|p| p.disk_read_rate.is_some()).count(),
                    items.iter().filter(|p| p.network_rx_rate.is_some()).count(),
                    items.iter().filter(|p| p.gpu_percent.is_some()).count()
                );
            }
        }
    }
}
