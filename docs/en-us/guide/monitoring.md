# Remote monitoring and process management

[简体中文](../../zh-cn/guide/monitoring.md)

The monitor page groups CPU, memory, network, disk and GPU into resource cards, combining each chart with its details and adapting to the current panel width. Choose **Edit layout** to drag the heading grip to reorder and the bottom corner to resize. Earlier/later, full/half width and reset buttons provide alternatives. Use Up/Down on the ordering grip and arrow keys on the resize handle; Escape cancels resizing. Narrow panels become one column while retaining desktop width preferences, and long details scroll inside cards. Layouts save per host and restore after reconnection. **Reset layout** affects the current host; resetting panel habits clears every host layout. Custom monitoring plugins manage their own interface; these controls apply to the built-in dashboard.

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
| Disk read/write  | Linux `/proc/PID/io` reports storage bytes, excluding cache hits. Windows CIM reports process I/O transfer bytes, which may include cached and non-disk I/O. Unavailable on macOS. Permissions may restrict access.     |
| TCP receive/send | Best-effort rates from visible TCP socket byte counters reported by `ss`. Does not include UDP, sockets that disappear between samples, or inaccessible owners. Shared sockets may be attributed to multiple processes. |
| GPU              | The busiest engine exposed by NVIDIA `nvidia-smi` or Linux DRM `fdinfo`. Driver capabilities determine availability.                                                                                                    |
| GPU memory       | Allocations exposed by the driver, deduplicated per device/client. NVIDIA compute-process accounting does not cover every graphics allocation.                                                                          |

`—` means unsupported, inaccessible or waiting for a valid second sample. Process monitoring detects the remote system: Linux uses `ps` and `/proc`, macOS uses system `ps` and `sysctl`, and Windows uses PowerShell and CIM. Collection does not install tools or request elevated permissions. macOS thread counts, I/O, TCP and GPU metrics are unavailable here; Windows UID/GID, TCP and GPU metrics are unavailable. Windows usernames require sufficient permissions. GPU support is optional. These counters are not a complete accounting
system for all process traffic or shared resources.

**Stop** uses the SSH user's existing permissions after confirmation. Linux and macOS send SIGTERM; Windows terminates the process directly.
PIDs 0 and 1 are protected. The application checks the process start identifier immediately
before sending the signal and rejects a process that has exited or been replaced.
Closing the dialog or switching servers invalidates a pending confirmation.

Process tables offer 25/50/100/200 rows, first/last navigation, direct page jumps and internal scrolling. Right-click or Shift+F10 opens process-tree termination, remote executable location and details. Tree termination requires confirmation. Run new task submits a background command as the SSH user (`sh` on Linux/macOS, PowerShell on Windows) with an optional absolute working directory. Windows accepts drive paths, UNC paths and SFTP `/C:/` paths; command length is bounded by the default SSH shell. Its PID acknowledges submission; there is no interactive terminal and input/output are discarded.

The monitor page and panel provide CPU, memory, disk, adapter and available NVIDIA GPU details. CPU includes speed, processes, threads, Linux file handles and logical CPU usage. Disks include activity, response time and rates. Values come from readable remote sources; missing tools/drivers and initial rates remain unavailable.
