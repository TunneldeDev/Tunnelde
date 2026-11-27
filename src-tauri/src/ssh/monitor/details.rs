//! Bounded, unprivileged Linux performance details. Missing values remain null.
use serde::Serialize;
use std::collections::HashMap;

pub(super) const SCRIPT: &str = r#"
echo '#hardware'
awk -F: '
/model name/ && !model {model=$2; sub(/^ +/,"",model); print "model\t"model}
/cpu MHz/ {sum+=$2; n++}
/physical id/ {socket[$2]=1; physical=$2}
/core id/ {core[physical ":" $2]=1}
/cache size/ && !cache {cache=$2; print "cache\t"cache}
END {if(n) print "mhz\t"sum/n; if(length(socket)) print "sockets\t"length(socket); if(length(core)) print "cores\t"length(core)}' /proc/cpuinfo 2>/dev/null
awk '{print "handles\t"$1-$2; print "handleLimit\t"$3}' /proc/sys/fs/file-nr 2>/dev/null
for field in cpuinfo_max_freq base_frequency; do
  value=$(cat /sys/devices/system/cpu/cpu0/cpufreq/$field 2>/dev/null)
  [ -n "$value" ] && printf '%s\t%s\n' "$field" "$value"
done
echo '#memoryDetails'
grep -E '^(MemAvailable|Cached|Buffers|SReclaimable|Slab|Committed_AS|CommitLimit|PageTables|KernelStack):' /proc/meminfo 2>/dev/null
echo '#coreDetails'; awk '/^cpu[0-9]+ / {print; if(++n>=4096)exit}' /proc/stat
# Leaf block devices avoid double-counting device-mapper layers.
echo '#diskDetails'
count=0
for device in /sys/block/*; do
  [ -r "$device/stat" ] || continue
  case "${device##*/}" in loop*|ram*|zram*|sr*|fd*) continue ;; esac
  set -- "$device"/slaves/*; [ -e "$1" ] && continue
  printf '%s\t' "${device##*/}"
  tr '\n' ' ' < "$device/stat"; printf '\t'
  tr '\n' ' ' < "$device/size"; printf '\t'
  cat "$device/queue/rotational" 2>/dev/null | tr '\n' ' '; printf '\t'
  cat "$device/device/model" 2>/dev/null | tr '\n' ' '; printf '\n'
  count=$((count+1)); [ "$count" -ge 32 ] && break
done
echo '#networkDetails'
count=0
for device in /sys/class/net/*; do
  [ -r "$device/statistics/rx_bytes" ] || continue
  printf '%s\t' "${device##*/}"
  for field in statistics/rx_bytes statistics/tx_bytes speed address operstate; do
    cat "$device/$field" 2>/dev/null | tr '\n' ' '; printf '\t'
  done
  printf '\n'; count=$((count+1)); [ "$count" -ge 64 ] && break
done
echo '#addresses'
if command -v ip >/dev/null 2>&1; then ip -o addr show 2>/dev/null | head -128; fi
echo '#gpuDetails'
# Optional driver calls cannot consume the entire shared sampling deadline.
if command -v timeout >/dev/null 2>&1 && command -v nvidia-smi >/dev/null 2>&1; then
  timeout 1 nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,driver_version --format=csv,noheader,nounits 2>/dev/null | head -16
fi
"#;

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PerformanceDetails {
    pub cpu_model: Option<String>,
    pub cpu_mhz: Option<f64>,
    pub base_mhz: Option<f64>,
    pub max_mhz: Option<f64>,
    pub sockets: Option<u64>,
    pub cores: Option<u64>,
    pub cache: Option<String>,
    pub processes: Option<u64>,
    pub threads: Option<u64>,
    /// Linux allocated file handles, not Windows kernel handles.
    pub file_handles: Option<u64>,
    pub file_handle_limit: Option<u64>,
    pub memory_available: Option<u64>,
    pub memory_cached: Option<u64>,
    pub memory_buffers: Option<u64>,
    pub memory_slab: Option<u64>,
    pub memory_committed: Option<u64>,
    pub memory_commit_limit: Option<u64>,
    pub page_tables: Option<u64>,
    pub kernel_stack: Option<u64>,
    pub logical_cpus: Vec<LogicalCpu>,
    pub disks: Vec<Disk>,
    pub networks: Vec<Network>,
    pub gpus: Vec<Gpu>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogicalCpu {
    pub name: String,
    pub percent: Option<f64>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Disk {
    pub name: String,
    pub model: String,
    pub capacity: Option<u64>,
    pub rotational: Option<bool>,
    pub read_rate: Option<f64>,
    pub write_rate: Option<f64>,
    pub active_percent: Option<f64>,
    pub response_ms: Option<f64>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Network {
    pub name: String,
    pub rx_rate: Option<f64>,
    pub tx_rate: Option<f64>,
    pub speed_mbps: Option<u64>,
    pub mac: String,
    pub state: String,
    pub addresses: Vec<String>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Gpu {
    pub name: String,
    pub percent: Option<f64>,
    pub memory_used: Option<u64>,
    pub memory_total: Option<u64>,
    pub temperature: Option<f64>,
    pub driver: String,
}
#[derive(Debug, Clone, Default)]
pub(super) struct DetailCounters {
    cores: HashMap<String, (u64, u64)>,
    disks: HashMap<String, Vec<u64>>,
    networks: HashMap<String, (u64, u64)>,
}
fn number(value: &str) -> Option<f64> {
    value
        .trim()
        .parse::<f64>()
        .ok()
        .filter(|v| v.is_finite() && *v >= 0.)
}
fn delta(value: u64, old: u64) -> Option<f64> {
    value.checked_sub(old).map(|v| v as f64)
}

pub(super) fn parse(
    raw: &str,
    previous: &DetailCounters,
    seconds: Option<f64>,
) -> (PerformanceDetails, DetailCounters) {
    let mut detail = PerformanceDetails::default();
    let mut next = DetailCounters::default();
    let mut section = "";
    for line in raw.lines() {
        if let Some(name) = line.strip_prefix('#') {
            section = name.trim();
            continue;
        }
        match section {
            "hardware" => {
                let Some((key, value)) = line.split_once('\t') else {
                    continue;
                };
                let value = value.trim();
                match key {
                    "model" => detail.cpu_model = Some(value.chars().take(256).collect()),
                    "mhz" => detail.cpu_mhz = number(value),
                    "base_frequency" => detail.base_mhz = number(value).map(|v| v / 1000.),
                    "cpuinfo_max_freq" => detail.max_mhz = number(value).map(|v| v / 1000.),
                    "sockets" => detail.sockets = value.parse().ok(),
                    "cores" => detail.cores = value.parse().ok(),
                    "cache" => detail.cache = Some(value.to_owned()),
                    "handles" => detail.file_handles = value.parse().ok(),
                    "handleLimit" => detail.file_handle_limit = value.parse().ok(),
                    _ => {}
                }
            }
            "memoryDetails" => {
                let Some((key, value)) = line.split_once(':') else {
                    continue;
                };
                let bytes = value
                    .split_whitespace()
                    .next()
                    .and_then(|v| v.parse::<u64>().ok())
                    .and_then(|v| v.checked_mul(1024));
                match key {
                    "MemAvailable" => detail.memory_available = bytes,
                    "Cached" => detail.memory_cached = bytes,
                    "Buffers" => detail.memory_buffers = bytes,
                    "Slab" => detail.memory_slab = bytes,
                    "Committed_AS" => detail.memory_committed = bytes,
                    "CommitLimit" => detail.memory_commit_limit = bytes,
                    "PageTables" => detail.page_tables = bytes,
                    "KernelStack" => detail.kernel_stack = bytes,
                    _ => {}
                }
            }
            "coreDetails" if detail.logical_cpus.len() < 4096 => {
                let mut fields = line.split_whitespace();
                let Some(name) = fields.next() else { continue };
                let values: Vec<u64> = fields.take(8).filter_map(|v| v.parse().ok()).collect();
                if values.len() != 8 {
                    continue;
                }
                let total = values.iter().sum();
                let idle = values[3] + values[4];
                let percent = previous.cores.get(name).and_then(|(old_total, old_idle)| {
                    let total = delta(total, *old_total)?;
                    let idle = delta(idle, *old_idle)?;
                    (total > 0.).then(|| ((total - idle) / total * 100.).clamp(0., 100.))
                });
                next.cores.insert(name.to_owned(), (total, idle));
                detail.logical_cpus.push(LogicalCpu {
                    name: name.to_owned(),
                    percent,
                });
            }
            "diskDetails" if detail.disks.len() < 32 => {
                let fields: Vec<_> = line.split('\t').collect();
                if fields.len() < 5 {
                    continue;
                }
                let values: Vec<u64> = fields[1]
                    .split_whitespace()
                    .filter_map(|v| v.parse().ok())
                    .collect();
                if values.len() < 11 {
                    continue;
                }
                let mut disk = Disk {
                    name: fields[0].to_owned(),
                    model: fields[4].trim().to_owned(),
                    capacity: fields[2]
                        .trim()
                        .parse::<u64>()
                        .ok()
                        .and_then(|v| v.checked_mul(512)),
                    rotational: match fields[3].trim() {
                        "0" => Some(false),
                        "1" => Some(true),
                        _ => None,
                    },
                    read_rate: None,
                    write_rate: None,
                    active_percent: None,
                    response_ms: None,
                };
                if let (Some(old), Some(seconds)) = (previous.disks.get(fields[0]), seconds) {
                    disk.read_rate = delta(values[2], old[2]).map(|v| v * 512. / seconds);
                    disk.write_rate = delta(values[6], old[6]).map(|v| v * 512. / seconds);
                    disk.active_percent =
                        delta(values[9], old[9]).map(|v| (v / seconds / 10.).clamp(0., 100.));
                    if let (Some(reads), Some(writes), Some(read_ms), Some(write_ms)) = (
                        delta(values[0], old[0]),
                        delta(values[4], old[4]),
                        delta(values[3], old[3]),
                        delta(values[7], old[7]),
                    ) {
                        if reads + writes > 0. {
                            disk.response_ms = Some((read_ms + write_ms) / (reads + writes));
                        }
                    }
                }
                next.disks.insert(fields[0].to_owned(), values);
                detail.disks.push(disk);
            }
            "networkDetails" if detail.networks.len() < 64 => {
                let fields: Vec<_> = line.split('\t').collect();
                if fields.len() < 6 {
                    continue;
                }
                let (Ok(rx), Ok(tx)) = (fields[1].trim().parse(), fields[2].trim().parse()) else {
                    continue;
                };
                let old = previous.networks.get(fields[0]);
                let rx_rate = old
                    .and_then(|v| delta(rx, v.0))
                    .zip(seconds)
                    .map(|(v, s)| v / s);
                let tx_rate = old
                    .and_then(|v| delta(tx, v.1))
                    .zip(seconds)
                    .map(|(v, s)| v / s);
                next.networks.insert(fields[0].to_owned(), (rx, tx));
                detail.networks.push(Network {
                    name: fields[0].to_owned(),
                    rx_rate,
                    tx_rate,
                    speed_mbps: fields[3].trim().parse::<u64>().ok().filter(|v| *v > 0),
                    mac: fields[4].trim().to_owned(),
                    state: fields[5].trim().to_owned(),
                    addresses: vec![],
                });
            }
            "addresses" => {
                let fields: Vec<_> = line.split_whitespace().collect();
                if fields.len() < 4 {
                    continue;
                }
                if let Some(network) = detail
                    .networks
                    .iter_mut()
                    .find(|n| n.name == fields[1].split('@').next().unwrap_or(""))
                {
                    if network.addresses.len() < 16 {
                        network.addresses.push(fields[3].to_owned());
                    }
                }
            }
            "gpuDetails" if detail.gpus.len() < 16 => {
                let fields: Vec<_> = line.split(',').map(str::trim).collect();
                if fields.len() != 6 {
                    continue;
                }
                let bytes = |v: &str| {
                    number(v)
                        .filter(|v| *v <= u64::MAX as f64 / 1048576.)
                        .map(|v| (v * 1048576.) as u64)
                };
                detail.gpus.push(Gpu {
                    name: fields[0].to_owned(),
                    percent: number(fields[1]).filter(|v| *v <= 100.),
                    memory_used: bytes(fields[2]),
                    memory_total: bytes(fields[3]),
                    temperature: number(fields[4]),
                    driver: fields[5].to_owned(),
                });
            }
            _ => {}
        }
    }
    (detail, next)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unknown_values_and_initial_rates_remain_unavailable() {
        let (detail,_)=parse("#hardware\nmhz\tNaN\n#networkDetails\neth0\t100\t200\t-1\taa:bb\tup\t\n#gpuDetails\nGPU, N/A, 1, 2, N/A, 555",&DetailCounters::default(),None);
        assert!(detail.cpu_mhz.is_none());
        assert!(detail.networks[0].rx_rate.is_none());
        assert!(detail.networks[0].speed_mbps.is_none());
        assert!(detail.gpus[0].percent.is_none());
        assert_eq!(detail.gpus[0].memory_used, Some(1048576));
    }
    #[test]
    fn computes_per_core_disk_latency_activity_and_network_rates() {
        let raw="#coreDetails\ncpu0 100 0 0 100 0 0 0 0\n#diskDetails\nsda\t10 0 100 50 20 0 200 70 0 100 0\t1000\t0\tSSD\n#networkDetails\neth0\t100\t200\t1000\taa:bb\tup\t";
        let (_, first) = parse(raw, &DetailCounters::default(), None);
        let next = raw
            .replace("100 0 0 100", "150 0 0 150")
            .replace(
                "10 0 100 50 20 0 200 70 0 100",
                "12 0 104 60 22 0 208 80 0 600",
            )
            .replace("eth0\t100\t200", "eth0\t2100\t4200");
        let (detail, _) = parse(&next, &first, Some(2.));
        assert_eq!(detail.logical_cpus[0].percent, Some(50.));
        assert_eq!(detail.disks[0].read_rate, Some(1024.));
        assert_eq!(detail.disks[0].write_rate, Some(2048.));
        assert_eq!(detail.disks[0].active_percent, Some(25.));
        assert_eq!(detail.disks[0].response_ms, Some(5.));
        assert_eq!(detail.networks[0].rx_rate, Some(1000.));
    }
    #[test]
    fn parses_memory_without_turning_missing_fields_into_zero() {
        let (detail, _) = parse(
            "#memoryDetails\nCached: 100 kB\nCommitted_AS: 200 kB",
            &DetailCounters::default(),
            None,
        );
        assert_eq!(detail.memory_cached, Some(102400));
        assert_eq!(detail.memory_committed, Some(204800));
        assert_eq!(detail.memory_available, None);
    }
}

#[cfg(all(test, target_os = "linux"))]
mod linux_tests {
    use super::*;
    #[test]
    fn samples_real_linux_proc_and_sys_sources_without_privileges() {
        let output = std::process::Command::new("sh")
            .args(["-c", SCRIPT])
            .output()
            .unwrap();
        let raw = String::from_utf8(output.stdout).unwrap();
        let (detail, _) = parse(&raw, &DetailCounters::default(), None);
        assert!(detail.memory_available.is_some(), "{raw}");
        assert!(!detail.logical_cpus.is_empty(), "{raw}");
        assert!(!detail.networks.is_empty(), "{raw}");
    }
}
