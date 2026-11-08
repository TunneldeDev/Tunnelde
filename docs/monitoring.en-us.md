# Remote monitoring and process management

[简体中文](monitoring.zh-cn.md)

CPU, memory, network and disk I/O charts share a timestamped history. Dashed
horizontal lines show the scale; hover a chart to inspect the sample time and exact
values. Keyboard users can focus a chart and use Left/Right or Home/End to inspect
samples. Open the full monitoring view from the panel header for larger charts.
The panel and full view share one sampling loop for the same connection. Resizing
changes the chart dimensions without rebuilding its sample geometry.

Open **Processes** from the remote monitoring panel. The process manager refreshes
using **Settings → Monitoring → Sampling interval**, waits for each request to finish,
and pauses while the application is hidden. Lightweight mode uses at least five
seconds between requests. **Pause updates** freezes the current view; **Refresh**
still requests one sample. An unsuccessful refresh keeps the previous rows and their
last successful update time.

Search by process name, PID, user, group, UID or GID. Click a column heading to sort;
click again to reverse its order. Unknown metrics sort last. Large lists use pages
of 100 processes. The table scrolls horizontally in narrow windows. Select a row to
inspect the user/group IDs, parent PID, thread count, state and per-core CPU usage.

| Metric           | Meaning and limitations                                                                                                                                                                                                 |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CPU              | Recent process CPU-time delta divided by the machine CPU-time delta, normalized to 0–100%. The per-core value in details can exceed 100% on multicore machines. The first sample has no interval yet.                   |
| Memory           | Resident memory (RSS). Shared pages can be included in several processes.                                                                                                                                               |
| Disk read/write  | Storage bytes per second from Linux `/proc/PID/io`, excluding cache hits. Access to another user's counters may be restricted.                                                                                          |
| TCP receive/send | Best-effort rates from visible TCP socket byte counters reported by `ss`. Does not include UDP, sockets that disappear between samples, or inaccessible owners. Shared sockets may be attributed to multiple processes. |
| GPU              | The busiest engine exposed by NVIDIA `nvidia-smi` or Linux DRM `fdinfo`. Driver capabilities determine availability.                                                                                                    |
| GPU memory       | Allocations exposed by the driver, deduplicated per device/client. NVIDIA compute-process accounting does not cover every graphics allocation.                                                                          |

`—` means unsupported, inaccessible or waiting for a valid second sample. Monitoring
uses read-only commands on Linux hosts; it does not install tools or request elevated
permissions. GPU support is optional. These counters are not a complete accounting
system for all process traffic or shared resources.

**Stop** sends SIGTERM after confirmation, using the SSH user's existing permissions.
PID 1 is protected. The application checks the process start identifier immediately
before sending the signal and rejects a process that has exited or been replaced.
Closing the dialog or switching servers invalidates a pending confirmation.
