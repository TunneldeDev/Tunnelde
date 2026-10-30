// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use russh::ChannelMsg;
use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::error::{AppError, AppResult};
use crate::models::now_ms;
use crate::state::AppState;

const SAMPLE_TIMEOUT: Duration = Duration::from_secs(8);

const SCRIPT: &str = r#"LANG=C
echo '#cpu'; head -1 /proc/stat
echo '#mem'; grep -E '^(MemTotal|MemAvailable|SwapTotal|SwapFree):' /proc/meminfo
echo '#disk'; df -kP / | tail -1
echo '#net'; awk 'NR>2 {rx+=$2; tx+=$10} END {print rx+0, tx+0}' /proc/net/dev
echo '#uptime'; cut -d' ' -f1 /proc/uptime
echo '#load'; cat /proc/loadavg
echo '#ps'; ps -eo pid=,pcpu=,pmem=,rss=,comm= --sort=-pcpu | head -5
echo '#nproc'; nproc
"#;

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RemoteProcess {
    pub pid: u32,
    pub name: String,
    pub cpu: f32,
    pub memory: f32,
    pub rss: u64,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RemoteStats {
    pub cpu_percent: f32,
    pub cpu_count: u32,
    pub memory_used: u64,
    pub memory_total: u64,
    pub swap_used: u64,
    pub swap_total: u64,
    pub disk_used: u64,
    pub disk_total: u64,
    pub load: [f32; 3],
    pub uptime: u64,
    pub net_rx_rate: f32,
    pub net_tx_rate: f32,
    pub processes: Vec<RemoteProcess>,
    pub sampled_at: i64,
}

#[derive(Debug, Clone, Copy, Default)]
struct Counters {
    cpu_total: u64,
    cpu_idle: u64,
    rx: u64,
    tx: u64,
    at: Option<Instant>,
}

#[derive(Default)]
pub struct MonitorCache {
    samples: Mutex<HashMap<String, Counters>>,
}

impl MonitorCache {
    fn previous(&self, session_id: &str) -> Counters {
        self.samples
            .lock()
            .ok()
            .and_then(|samples| samples.get(session_id).copied())
            .unwrap_or_default()
    }

    fn store(&self, session_id: &str, counters: Counters) {
        if let Ok(mut samples) = self.samples.lock() {
            samples.insert(session_id.to_string(), counters);
        }
    }

    pub fn forget(&self, session_id: &str) {
        if let Ok(mut samples) = self.samples.lock() {
            samples.remove(session_id);
        }
    }
}

async fn exec(app: &AppHandle, session_id: &str, command: &str) -> AppResult<String> {
    let handle = app.state::<AppState>().ssh.handle(session_id)?;
    let mut channel = handle
        .channel_open_session()
        .await
        .map_err(|error| AppError::Ssh(format!("monitor.channel: {error}")))?;
    channel
        .exec(true, command)
        .await
        .map_err(|error| AppError::Ssh(format!("monitor.exec: {error}")))?;

    let collect = async {
        let mut output = Vec::new();
        while let Some(message) = channel.wait().await {
            match message {
                ChannelMsg::Data { data } => output.extend_from_slice(&data),
                ChannelMsg::Eof | ChannelMsg::Close => break,
                _ => {}
            }
        }
        output
    };

    let output = tokio::time::timeout(SAMPLE_TIMEOUT, collect)
        .await
        .map_err(|_| AppError::Ssh("monitor.timeout".into()))?;

    Ok(String::from_utf8_lossy(&output).into_owned())
}

fn parse_kb(value: &str) -> u64 {
    value
        .split_whitespace()
        .next()
        .and_then(|field| field.parse::<u64>().ok())
        .map(|kb| kb * 1024)
        .unwrap_or(0)
}

pub async fn sample(app: &AppHandle, session_id: &str) -> AppResult<RemoteStats> {
    let raw = exec(app, session_id, SCRIPT).await?;
    let cache = &app.state::<AppState>().monitor;
    let previous = cache.previous(session_id);

    let mut stats = RemoteStats {
        sampled_at: now_ms(),
        ..RemoteStats::default()
    };
    let mut counters = Counters::default();
    let mut section = "";

    for line in raw.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Some(name) = line.strip_prefix('#') {
            section = name.trim();
            continue;
        }

        match section {
            "cpu" => {
                let values: Vec<u64> = line
                    .split_whitespace()
                    .skip(1)
                    .filter_map(|value| value.parse::<u64>().ok())
                    .collect();
                counters.cpu_total = values.iter().sum();
                counters.cpu_idle =
                    values.get(3).copied().unwrap_or(0) + values.get(4).copied().unwrap_or(0);
            }
            "mem" => {
                if let Some(value) = line.strip_prefix("MemTotal:") {
                    stats.memory_total = parse_kb(value);
                } else if let Some(value) = line.strip_prefix("MemAvailable:") {
                    stats.memory_used = parse_kb(value);
                } else if let Some(value) = line.strip_prefix("SwapTotal:") {
                    stats.swap_total = parse_kb(value);
                } else if let Some(value) = line.strip_prefix("SwapFree:") {
                    let free = parse_kb(value);
                    stats.swap_used = stats.swap_total.saturating_sub(free);
                }
            }
            "disk" => {
                let fields: Vec<&str> = line.split_whitespace().collect();
                if fields.len() >= 3 {
                    stats.disk_total = fields[1].parse::<u64>().unwrap_or(0) * 1024;
                    stats.disk_used = fields[2].parse::<u64>().unwrap_or(0) * 1024;
                }
            }
            "net" => {
                let fields: Vec<&str> = line.split_whitespace().collect();
                if fields.len() == 2 {
                    counters.rx = fields[0].parse().unwrap_or(0);
                    counters.tx = fields[1].parse().unwrap_or(0);
                }
            }
            "uptime" => {
                stats.uptime = line
                    .split('.')
                    .next()
                    .and_then(|value| value.parse().ok())
                    .unwrap_or(0);
            }
            "load" => {
                let values: Vec<f32> = line
                    .split_whitespace()
                    .take(3)
                    .filter_map(|value| value.parse().ok())
                    .collect();
                if values.len() == 3 {
                    stats.load = [values[0], values[1], values[2]];
                }
            }
            "ps" => {
                if let Some(process) = parse_process(line) {
                    stats.processes.push(process);
                }
            }
            "nproc" => {
                stats.cpu_count = line.parse().unwrap_or(0);
            }
            _ => {}
        }
    }

    stats.memory_used = stats.memory_total.saturating_sub(stats.memory_used);

    if previous.cpu_total > 0 && counters.cpu_total > previous.cpu_total {
        let total_delta = counters.cpu_total - previous.cpu_total;
        let idle_delta = counters.cpu_idle.saturating_sub(previous.cpu_idle);
        let busy = total_delta.saturating_sub(idle_delta);
        stats.cpu_percent = (busy as f32 / total_delta as f32) * 100.0;
    }

    let now = Instant::now();
    if let Some(previous_at) = previous.at {
        let seconds = now.duration_since(previous_at).as_secs_f32().max(0.2);
        stats.net_rx_rate = counters.rx.saturating_sub(previous.rx) as f32 / seconds;
        stats.net_tx_rate = counters.tx.saturating_sub(previous.tx) as f32 / seconds;
    }
    counters.at = Some(now);

    cache.store(session_id, counters);
    Ok(stats)
}

fn parse_process(line: &str) -> Option<RemoteProcess> {
    let fields: Vec<&str> = line.split_whitespace().collect();
    if fields.len() < 5 {
        return None;
    }
    let pid = fields[0].parse::<u32>().ok()?;
    let cpu = fields[1].parse::<f32>().ok()?;
    let memory = fields[2].parse::<f32>().ok()?;
    let rss = fields[3].parse::<u64>().unwrap_or(0) * 1024;
    Some(RemoteProcess {
        pid,
        cpu,
        memory,
        rss,
        name: fields[4..].join(" "),
    })
}

const PROCESS_SCRIPT: &str = r#"LANG=C
ps -eo pid=,pcpu=,pmem=,rss=,comm= --sort=-pcpu | head -40
"#;

pub async fn processes(app: &AppHandle, session_id: &str) -> AppResult<Vec<RemoteProcess>> {
    let raw = exec(app, session_id, PROCESS_SCRIPT).await?;
    Ok(raw.lines().filter_map(parse_process).collect())
}

pub async fn kill(app: &AppHandle, session_id: &str, pid: u32) -> AppResult<()> {
    if pid <= 1 {
        return Err(AppError::Ssh("monitor.killProtected".into()));
    }
    let output = exec(app, session_id, &format!("kill -TERM {pid} 2>&1")).await?;
    if output.trim().is_empty() {
        Ok(())
    } else {
        Err(AppError::Ssh(format!(
            "monitor.killFailed: {}",
            output.trim()
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ps_rows() {
        let process = parse_process("  4242  12.5  3.1  65536  sshd").expect("process");
        assert_eq!(process.pid, 4242);
        assert!((process.cpu - 12.5).abs() < 0.01);
        assert!((process.memory - 3.1).abs() < 0.01);
        assert_eq!(process.rss, 65536 * 1024);
        assert_eq!(process.name, "sshd");
    }

    #[test]
    fn keeps_names_with_spaces() {
        let process = parse_process("7 0.0 0.0 512 some worker").expect("process");
        assert_eq!(process.name, "some worker");
    }

    #[test]
    fn rejects_short_rows() {
        assert!(parse_process("12 1.0").is_none());
        assert!(parse_process("").is_none());
    }
}
