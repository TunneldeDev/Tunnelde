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
Pause and Cancel retain partial data so Resume remains possible. The trash action
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
page and expand **Port forwarding**. Add a named rule:

| Direction                       | Listener      | Destination is reached from |
| ------------------------------- | ------------- | --------------------------- |
| Local listener → remote service | This computer | The SSH host                |
| Remote listener → local service | The SSH host  | This computer               |

For a remote database listening on `127.0.0.1:5432`, a local rule could listen on
`127.0.0.1:15432` and forward to `127.0.0.1:5432`. Applications then connect to
local port 15432. For remote forwarding, the destination address refers to this
computer's network rather than the remote host's network.

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
