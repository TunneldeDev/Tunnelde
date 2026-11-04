# Network routes, transfers and SSHFS

These features require desktop 0.27.0 or newer. Existing hosts
and preferences keep their current values; no proxy or jump host is required.

## Feature proxies

Open **Settings → Network & proxies**. Add named HTTP CONNECT or SOCKS5 profiles,
then choose a default route. Override application updates, marketplace/downloads,
SSH/SFTP/forwarding, local plugin processes, or an individual plugin independently.
Each choice supports the inherited default, system proxy, direct connection, or a
named profile. Proxy passwords are stored in the operating system credential store.
An empty password keeps the saved value; **Forget saved proxy password** removes it
only when saved. The connection test uses the route selected in its own dropdown.

Proxy profiles are edited inline with separate connection and authentication groups.
Feature routes use aligned controls and stack vertically in narrow panes. Individual
plugin overrides stay in a collapsible list. The connection test labels its destination
address and port separately from the proxy server and locks its inputs until it finishes.

SSH and native HTTP requests use system/environment proxy settings and bypass
rules in system mode. PAC scripts are not evaluated. Explicit SOCKS5 routes resolve
destination hostnames through the proxy. An unavailable or rejected explicit proxy
fails the request instead of silently making a direct connection.

Local executable plugins and AI tasks receive explicit proxy routes through
`HTTP_PROXY`, `HTTPS_PROXY` and `ALL_PROXY`, including their lowercase variants.
Loopback traffic bypasses these proxies. System mode inherits the process environment;
it does not translate desktop OS proxy settings into environment variables. An
executable must support the supplied variables. Restart running plugins to apply
route changes. Remote processes use their own host's outbound networking settings.

Preference profiles include proxy metadata and per-feature choices, with no proxy
passwords. Exported metadata includes proxy usernames and addresses. Importing on
another computer requires entering its proxy passwords again. Deleting a proxy or
resetting Network preferences forgets the removed profiles' stored passwords.

## SSH jump hosts

Edit a saved host and expand **Proxy & jump hosts**. Choose a proxy and add saved
hosts in connection order, with the outermost jump first. Reorder or remove entries
with the adjacent controls. The route supports up to eight distinct jump hosts;
the destination cannot also be a jump host. This explicit list is the complete
route: a jump host's own saved jump list is not recursively expanded.

Only the first TCP connection uses the destination route's proxy. Later hops use
authenticated SSH `direct-tcpip` channels. Every hop retains its own password/key
authentication and host-key check. The connection dialog names the machine whose
key is being reviewed, asks for any missing jump credentials, and verifies the
destination before enabling Connect. Changing a route does not bypass key trust.
SFTP, port forwards and SSHFS reuse the resulting authenticated connection.

## Transfer performance

In **Settings → Files → Transfers**, total upload and download limits are set
independently in KiB/s. Both default to `0` (unlimited), apply immediately to
running tasks, and share one budget across concurrent transfers and SFTP data
channels. They remain active when transfer optimization is disabled. Remote to
remote transfers use both budgets; local disk copies use neither. These limits
cover file-transfer payload bytes rather than SSH framing or terminal traffic.

The gauge button on a running transfer opens a temporary task limit. `0` follows
the global limits; a positive value adds a task ceiling and cannot override the
global ceiling. Pausing and resuming starts with the global limits again. Low
speed transfers continue reporting progress, and pause/cancel can interrupt the
limiter wait. Requests already dispatched when a limit changes may finish.

**Settings → Files → Transfers** enables transfer optimization by default. Segment
concurrency, segment size and SFTP requests per segment each default to **Automatic**.
The application selects fewer segments for small files and up to four for larger remote
files; manual concurrency supports 1, 2, 4 or 8 segments. Local copies remain sequential.
Segment size can be automatic or 256 KiB, 1 MiB, 4 MiB or 16 MiB. Request depth can be
automatic or 1, 4, 8, 16 or 32 per segment, with a cap of 64 total in-flight requests.
Changes apply on start/resume and travel with settings profiles.

Concurrent segments use explicit file offsets over dedicated SFTP data channels. Uploads,
downloads and remote-to-remote copies honor advertised server packet limits, handle short
reads and do not prefetch past a segment boundary. Metadata and directory operations
retain their own channels. A journal records the confirmed contiguous prefix before each
window of segments. Resume discards an interrupted window before verifying the prefix;
sparse writes are never interpreted as completed data. Workers stop and drain before file
handles are closed or temporary files can be cleaned.

This optimization does not yet compress files or batch a folder into an archive.

## Pause and resume transfers

The transfer list offers Pause, Resume, Cancel and Clear. A desktop-owned transfer
stores its task and per-file progress locally. After an interruption or restart,
connect to the same saved host and resume from the list; changing terminal session
IDs does not require recreating the task. Local transfers can resume immediately.

Data is written into a task-owned `.tunnelde-….part` sibling. A clean pause saves
its closed file's size and modification time. If both source and staging metadata
still match, resume verifies the first and last blocks and continues at the saved
offset. Interrupted writes, legacy tasks and changed staging metadata use full prefix
verification. A changed source or mismatched partial file is rejected. Verification
has its own visible status and can be cancelled while awaiting network reads.

Overwrite uses a recoverable, verified backup of the previous destination. For a
move, source removal happens after the copy succeeds and is checkpointed separately.
Pause retains partial data for Resume. Cancel stops the transfer and removes its owned
temporary data before reporting completion. It keeps already completed destination
files and never deletes source data. Cancelled tasks cannot resume. If cleanup fails
(e.g. the remote disconnected), the record explains that cleanup needs a retry;
reconnect and use the trash action. The trash action
**Remove transfer and clean temporary files** deletes task-owned staging files before
removing the journal. It restores a verified original destination backup if a commit
was interrupted. Completed destination files and source files are preserved.

Reconnect a remote destination before cleaning an unfinished task. Failed cleanup
keeps the record for retry, and cleanup and resume cannot run at the same time.
Legacy directory transfers with an unidentified original backup keep that backup and
report that recovery is needed. Completed records can be removed while offline.

The transfer list shows transferred and remaining bytes, recent throughput and an
estimated remaining time. Throughput history resets on resume; existing bytes do not
count as newly transferred traffic.

Executable-plugin transfers remain tied to the authorized runtime and cannot resume
after an application restart or privilege revocation.

## Local and remote port forwarding

Click **Port forwarding** in the SSH terminal toolbar to manage that host's rules,
with the current terminal session preselected. You can also open the host's detail
page and expand **Port forwarding**. Choose **Add forward**, then select **Access a remote
service** or **Share a local service**. The editor separates the listening and service
endpoints and names the computer that resolves each address. Names are optional and default
to the service address and port. Choose **Save and start** with a live SSH connection,
or **Save** to keep an inactive rule. An offline view always offers **Connect**.

| Direction                       | Listener      | Destination is reached from |
| ------------------------------- | ------------- | --------------------------- |
| Local listener → remote service | This computer | The SSH host                |
| Remote listener → local service | The SSH host  | This computer               |

For a remote database listening on `127.0.0.1:5432`, a local rule could listen on
`127.0.0.1:15432` and forward to `127.0.0.1:5432`. Applications then connect to
local port 15432. For remote forwarding, the destination address refers to this
computer's network rather than the remote host's network.

The rule list keeps Start/Stop visible and puts Edit, Copy local connection address and
Delete in each rule's actions menu. An active rule must be stopped before editing.
Startup failures stay beside the saved rule so Start can retry without creating duplicates;
save failures keep the editor draft. Other open forwarding views refresh after changes.
Endpoint groups stack vertically in narrow panes.

Rules persist, but listeners start manually after connecting. Loopback is the
default; exposing a listener requires confirmation. Remote listeners depend on
the SSH server's forwarding policy and `GatewayPorts`. Stopping a rule or closing
its session stops its listener and existing forwarded connections. Rules owned by
a plugin also stop when its permissions are revoked or its runtime exits.

## SSHFS plugins

The independent hub provides **SSHFS** (Node) and **SSHFS Lite** (declarative,
without Node). Both require desktop 0.27.0+ and use the same native mount panel.
Open either from Quick Access or its contributed view, select a connected host,
browse a remote directory, and choose a local empty directory or unused Windows
drive such as `Z:\`. Mounts default to read only.

The panel detects FUSE and an SSHFS build with passive/stdin transport support.
It provides installation guidance when dependencies are missing or incompatible;
it does not install drivers. The Node version still requires runtime consent.

The native service pipes an authenticated SFTP subsystem directly to SSHFS.
Passwords and private keys are not passed in process arguments, and no local TCP
bridge is exposed. Mount completion is reported after the mount appears in the
operating system. Mount points are reserved across both plugins.

Use Unmount before disconnecting. Disconnect, plugin stop/revocation and app exit
close authenticated access and attempt normal cleanup. If a directory is busy,
close files using it and retry; forced unmount requires confirmation. Mounts do
not automatically restart. Driver compatibility and platform-specific mount
behavior must also be tested with the installed SSHFS distribution.

## File previews

Select one file in either pane and press Space, click the Preview toolbar button, or
choose Preview from its context menu. Text previews are read only; Markdown opens rendered
with a source switch. Local text is bounded to 512 KiB and remote text to the existing
2 MiB read limit. Unsupported or binary files report a preview error. Remote previews
use the selected pane's SSH session. Close returns focus to the file list; the footer
can open a local file with the OS or edit a connected remote text file.

PDF/image viewers and contributed preview providers are not implemented by this change.
