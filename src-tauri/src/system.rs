// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

use std::collections::HashMap;

use serde::Serialize;
use sysinfo::{Disks, Pid, ProcessesToUpdate, System};

use crate::models::now_ms;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskInfo {
    pub mount: String,
    pub total: u64,
    pub available: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemStats {
    pub cpu_usage: f32,
    pub memory_used: u64,
    pub memory_total: u64,
    pub swap_used: u64,
    pub swap_total: u64,
    pub disk_used: u64,
    pub disk_total: u64,
    pub uptime: u64,
    pub load_average: [f32; 3],
    pub process_count: usize,
    pub app_memory: u64,
    pub app_processes: usize,
    pub disks: Vec<DiskInfo>,
    pub sampled_at: i64,
}

/// Samples the local machine. CPU usage is a delta between calls, so the
/// caller is expected to poll at a steady interval.
pub fn snapshot(system: &mut System, disks: &mut Disks) -> SystemStats {
    system.refresh_cpu_usage();
    system.refresh_memory();
    system.refresh_processes(ProcessesToUpdate::All, true);
    disks.refresh(true);

    let mut disk_total = 0_u64;
    let mut disk_available = 0_u64;
    let mut entries: Vec<DiskInfo> = disks
        .list()
        .iter()
        .map(|disk| DiskInfo {
            mount: disk.mount_point().to_string_lossy().into_owned(),
            total: disk.total_space(),
            available: disk.available_space(),
        })
        .collect();
    entries.sort_by(|left, right| right.total.cmp(&left.total));
    entries.dedup_by(|left, right| left.mount == right.mount);
    for entry in &entries {
        disk_total += entry.total;
        disk_available += entry.available;
    }
    entries.truncate(6);

    let (app_memory, app_processes) = process_tree_memory(system);
    let load = System::load_average();

    SystemStats {
        cpu_usage: system.global_cpu_usage(),
        memory_used: system.used_memory(),
        memory_total: system.total_memory(),
        swap_used: system.used_swap(),
        swap_total: system.total_swap(),
        disk_used: disk_total.saturating_sub(disk_available),
        disk_total,
        uptime: System::uptime(),
        load_average: [load.one as f32, load.five as f32, load.fifteen as f32],
        process_count: system.processes().len(),
        app_memory,
        app_processes,
        disks: entries,
        sampled_at: now_ms(),
    }
}

/// Sums RSS for this process and every descendant (WebView2 helpers on
/// Windows, WebKit helpers on macOS/Linux).
fn process_tree_memory(system: &System) -> (u64, usize) {
    let Some(root) = sysinfo::get_current_pid().ok() else {
        return (0, 0);
    };

    let mut children: HashMap<Pid, Vec<Pid>> = HashMap::new();
    for (pid, process) in system.processes() {
        if let Some(parent) = process.parent() {
            children.entry(parent).or_default().push(*pid);
        }
    }

    let mut total = 0_u64;
    let mut count = 0_usize;
    let mut stack = vec![root];
    let mut guard = 0_usize;
    while let Some(pid) = stack.pop() {
        guard += 1;
        if guard > 4096 {
            break;
        }
        if let Some(process) = system.process(pid) {
            total += process.memory();
            count += 1;
        }
        if let Some(kids) = children.get(&pid) {
            stack.extend(kids.iter().copied());
        }
    }
    (total, count)
}
